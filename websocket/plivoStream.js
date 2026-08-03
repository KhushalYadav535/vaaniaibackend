/**
 * Plivo Bi-directional Audio Stream WebSocket Handler
 *
 * Architecture (Zoronal/Retell/Vapi style):
 *   Plivo Phone Call
 *     ↕ mulaw/8000 audio over WebSocket (every 20ms)
 *   This Handler
 *     ↕ PCM/8000 → Deepgram Live STT (streaming)
 *     ↕ speech_final → voicePipeline LLM (streaming tokens)
 *     ↕ TTS audio buffer → transcode to mulaw/8000 → Plivo WS
 *
 * Latency target: <800ms end-to-end (user stops speaking → AI audio starts)
 *
 * Plivo WebSocket Message Protocol:
 *   From Plivo:
 *     { event: "start",  start: { callId, streamId, customParameters: { agentId, callUuid } } }
 *     { event: "media",  media: { payload: "<base64 mulaw>", chunk, timestamp } }
 *     { event: "stop" }
 *     { event: "dtmf",   dtmf: { digit } }
 *
 *   To Plivo (TTS audio):
 *     { event: "playAudio",  media: { payload: "<base64 mulaw 8kHz>", sampleRate: 8000, audioFormat: "pcm" } }
 *     { event: "clearAudio", id: "<streamId>" }
 */

'use strict';

const { v4: uuidv4 }    = require('uuid');
const Agent              = require('../models/Agent');
const User               = require('../models/User');
const CallLog            = require('../models/CallLog');
const PhoneNumber        = require('../models/PhoneNumber');
const voicePipeline      = require('../services/voicePipeline');
const deepgramService    = require('../services/deepgramService');
const ttsService         = require('../services/ttsService');
const toolExecutor       = require('../services/toolExecutor');
const webhookDispatcher  = require('../services/webhookDispatcher');

// ─── In-memory session store ────────────────────────────────────────────────
const plivoStreamSessions = new Map();

// ─── μ-law (G.711) codec helpers — pure JS, no native deps ─────────────────
const MULAW_BIAS   = 0x84;
const MULAW_MAX    = 32767;
const MULAW_CLIP   = MULAW_MAX;

/**
 * Encode a signed 16-bit linear PCM sample to an 8-bit G.711 μ-law byte.
 * Formula: ITU-T G.711 standard.
 */
function pcm16ToMulaw(sample) {
  let s = Math.max(-MULAW_CLIP, Math.min(MULAW_CLIP, sample));
  const sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  s += MULAW_BIAS;
  const exp = Math.floor(Math.log2(s)) - 6; // exponent
  const clampedExp = Math.max(0, Math.min(7, exp));
  const mantissa   = (s >> (clampedExp + 3)) & 0x0F;
  return ~(sign | (clampedExp << 4) | mantissa) & 0xFF;
}

/**
 * Decode a G.711 μ-law byte to a signed 16-bit linear PCM sample.
 */
function mulawToPcm16(byte) {
  const comp = ~byte;
  const sign = comp & 0x80;
  const exp  = (comp >> 4) & 0x07;
  const mant = comp & 0x0F;
  let sample = ((mant << 3) + MULAW_BIAS) << exp;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/**
 * Decode a G.711 μ-law Buffer to a Buffer of signed 16-bit LE PCM samples.
 * Output length = input.length * 2.
 */
function mulawBufferToPcm16Buffer(mulawBuf) {
  const out = Buffer.allocUnsafe(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const pcm = mulawToPcm16(mulawBuf[i]);
    out.writeInt16LE(pcm, i * 2);
  }
  return out;
}

/**
 * Encode a Buffer of signed 16-bit LE PCM samples (at any sample rate)
 * to G.711 μ-law at 8000 Hz (resampled with linear interpolation).
 *
 * @param {Buffer} pcmBuf   - input PCM16 LE buffer
 * @param {number} srcRate  - source sample rate (e.g. 44100, 22050, 16000)
 * @returns {Buffer}        - mulaw buffer at 8000 Hz
 */
function pcm16BufferToMulaw8k(pcmBuf, srcRate = 44100) {
  const srcSamples = pcmBuf.length / 2; // 16-bit = 2 bytes per sample
  const dstSamples = Math.floor(srcSamples * (8000 / srcRate));
  const out        = Buffer.allocUnsafe(dstSamples);

  for (let i = 0; i < dstSamples; i++) {
    const srcIdx  = (i * srcRate) / 8000;
    const floor   = Math.floor(srcIdx);
    const frac    = srcIdx - floor;
    const s0 = floor * 2 < pcmBuf.length ? pcmBuf.readInt16LE(floor * 2) : 0;
    const s1 = (floor + 1) * 2 < pcmBuf.length ? pcmBuf.readInt16LE((floor + 1) * 2) : s0;
    const interpolated = Math.round(s0 + frac * (s1 - s0));
    out[i] = pcm16ToMulaw(interpolated);
  }
  return out;
}

// ─── MP3 → PCM16 → mulaw/8000 transcoding ──────────────────────────────────

let audioDecode;
try {
  audioDecode = require('audio-decode');
} catch (e) {
  audioDecode = null;
  console.warn('[PlivoStream] audio-decode not installed — MP3→mulaw transcoding unavailable, using fallback.');
}

/**
 * Convert an MP3 Buffer (from ElevenLabs/Edge-TTS) to mulaw 8000 Hz Buffer.
 * Falls back to sending raw TTS as-is (Plivo will try to play it anyway) if
 * audio-decode is unavailable.
 *
 * @param {Buffer} mp3Buffer
 * @returns {Promise<Buffer>} mulaw buffer at 8000 Hz
 */
async function mp3ToMulaw8k(mp3Buffer) {
  if (!audioDecode || !mp3Buffer || mp3Buffer.length === 0) return mp3Buffer;

  try {
    const decoded = await audioDecode(mp3Buffer);
    const sampleRate   = decoded.sampleRate   || 44100;
    const channelCount = decoded.channelCount  || 1;
    const numSamples   = decoded.length;

    // Mix down to mono (average channels)
    const monoFloat32 = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let c = 0; c < channelCount; c++) {
        const ch = decoded.getChannelData(c);
        sum += ch[i];
      }
      monoFloat32[i] = sum / channelCount;
    }

    // Float32 [-1,+1] → Int16 signed PCM
    const pcm16Buf = Buffer.allocUnsafe(numSamples * 2);
    for (let i = 0; i < numSamples; i++) {
      const clamped = Math.max(-1, Math.min(1, monoFloat32[i]));
      pcm16Buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
    }

    return pcm16BufferToMulaw8k(pcm16Buf, sampleRate);
  } catch (err) {
    console.error('[PlivoStream] MP3→mulaw transcoding failed:', err.message);
    return mp3Buffer; // fallback
  }
}

// ─── Session helpers ─────────────────────────────────────────────────────────

function sendToPlivo(ws, event) {
  try {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(event));
    }
  } catch (_) {}
}

function sendAudioToPlivo(session, mulawBuffer) {
  if (!session.ws || session.ws.readyState !== 1) return;
  if (!mulawBuffer || mulawBuffer.length === 0) return;
  sendToPlivo(session.ws, {
    event: 'playAudio',
    media: {
      contentType: 'audio/x-mulaw',
      sampleRate:  8000,
      payload:     mulawBuffer.toString('base64'),
    },
  });
}

function clearAudioOnPlivo(session) {
  if (!session.ws || session.ws.readyState !== 1) return;
  sendToPlivo(session.ws, {
    event: 'clearAudio',
    id:    session.streamId || '',
  });
}

function stopInterrupt(session) {
  if (!session._interruptLock) {
    session._interruptLock = true;
    setTimeout(() => { session._interruptLock = false; }, 1200);
  }

  // Cancel in-flight LLM
  if (session._currentAbortController) {
    try { session._currentAbortController.abort(); } catch (_) {}
    session._currentAbortController = null;
  }

  session.agentSpeaking = false;
  session.isProcessing  = false;
  session.currentGenerationId = uuidv4();

  // Tell Plivo to stop playing buffered audio immediately
  clearAudioToPlivo(session);
}

// ─── Core: process finalized user transcript through LLM → TTS → Plivo ──────

async function processUserTranscript(session, text) {
  if (!text || text.trim().length < 2) return;
  if (session.status === 'ended') return;

  // Re-entrancy guard
  if (session.isProcessing) {
    session._pendingTranscript = text;
    return;
  }
  session.isProcessing = true;

  const turnStartedAt    = Date.now();
  const generationId     = uuidv4();
  session.currentGenerationId = generationId;

  const abortController  = new AbortController();
  session._currentAbortController = abortController;

  try {
    console.log(`[PlivoStream][${session.callUuid}] 🗣  User: "${text.slice(0, 80)}"`);

    // Save user turn
    session.history.push({ role: 'user', content: text, timestamp: new Date() });
    if (session.callLogId) {
      await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { role: 'user', content: text, timestamp: new Date() } },
      }).catch(() => {});
    }

    // Check for end-call phrases
    const endPhrases = session.agent.endCallPhrases || ['bye', 'goodbye', 'thanks bye', 'thank you bye'];
    if (endPhrases.some(p => text.toLowerCase().includes(p.toLowerCase()))) {
      const endMsg = session.agent.endCallMessage || 'Thank you for calling. Goodbye!';
      await speakAndPlay(session, endMsg, generationId);
      await endSession(session, 'user_hangup');
      return;
    }

    // --- LLM Call ---
    const llmStart = Date.now();
    const aiResult = await voicePipeline.processText({
      text,
      agent:        session.agent,
      history:      session.history.slice(-12),
      userSettings: session.userSettings || {},
      abortSignal:  abortController.signal,
    });

    if (session.currentGenerationId !== generationId) {
      console.log(`[PlivoStream][${session.callUuid}] Generation ${generationId} superseded — dropping.`);
      return;
    }

    const llmMs = Date.now() - llmStart;
    console.log(`[PlivoStream][${session.callUuid}] 🤖 LLM (${llmMs}ms): "${(aiResult.response || '').slice(0, 80)}"`);

    // Execute tool calls (non-blocking)
    if (aiResult.toolCalls && aiResult.toolCalls.length > 0) {
      toolExecutor.executeToolCalls({
        toolCalls:    aiResult.toolCalls,
        agentContext: { agentId: session.agent._id, userId: session.agent.userId, callUuid: session.callUuid },
      }).catch(e => console.error('[PlivoStream] Tool error:', e.message));
    }

    // Save assistant turn
    const assistantText = aiResult.response || '';
    session.history.push({ role: 'assistant', content: assistantText, timestamp: new Date() });
    if (session.callLogId) {
      await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { role: 'assistant', content: assistantText, timestamp: new Date() } },
      }).catch(() => {});
    }

    // --- TTS → Audio to Plivo ---
    if (assistantText && session.currentGenerationId === generationId) {
      await speakAndPlay(session, assistantText, generationId);
    }

    const totalMs = Date.now() - turnStartedAt;
    console.log(`[PlivoStream][${session.callUuid}] ⚡ Total turn latency: ${totalMs}ms`);

  } catch (err) {
    if (err.name === 'AbortError') {
      console.log(`[PlivoStream][${session.callUuid}] LLM aborted (interrupt)`);
    } else {
      console.error(`[PlivoStream][${session.callUuid}] processUserTranscript error:`, err.message);
    }
  } finally {
    if (session.currentGenerationId === generationId) {
      session.isProcessing = false;

      // Process any queued transcript that arrived during LLM
      const pending = session._pendingTranscript;
      if (pending) {
        session._pendingTranscript = null;
        setImmediate(() => processUserTranscript(session, pending));
      }
    }
  }
}

/**
 * Generate TTS audio, transcode to mulaw/8000, send to Plivo.
 */
async function speakAndPlay(session, text, generationId) {
  if (!text || session.status === 'ended') return;
  try {
    const ttsStart  = Date.now();
    const agent     = session.agent;
    const mp3Buffer = await ttsService.textToSpeech({
      text,
      voiceId:  agent.voice?.voiceId  || 'en-IN-NeerjaNeural',
      provider: agent.voice?.provider || 'edge-tts',
      speed:    agent.voice?.speed    || 1.0,
      apiKey:   session.userSettings?.elevenLabsKey || process.env.ELEVENLABS_API_KEY,
    });

    if (session.currentGenerationId !== generationId || session.status === 'ended') return;

    const mulawBuf = await mp3ToMulaw8k(mp3Buffer);
    const ttsMs    = Date.now() - ttsStart;

    console.log(`[PlivoStream][${session.callUuid}] 🔊 TTS (${ttsMs}ms, ${mulawBuf.length} bytes mulaw)`);

    if (session.currentGenerationId !== generationId || session.status === 'ended') return;

    session.agentSpeaking = true;
    sendAudioToPlivo(session, mulawBuf);
    session.agentSpeaking = false;

  } catch (err) {
    console.error(`[PlivoStream][${session.callUuid}] TTS error:`, err.message);
  }
}

// ─── Session lifecycle ────────────────────────────────────────────────────────

async function initSession(session, startEvent) {
  const params   = startEvent.start?.customParameters || {};
  const agentId  = params.agentId;
  const callUuid = params.callUuid || startEvent.start?.callId || '';
  const fromNum  = params.from     || '';
  const toNum    = params.to       || '';

  session.callUuid  = callUuid;
  session.streamId  = startEvent.start?.streamId || '';
  session.fromNum   = fromNum;
  session.toNum     = toNum;

  console.log(`[PlivoStream][${callUuid}] 📞 Call started. AgentId=${agentId || 'lookup'}`);

  // --- Resolve agent ---
  let agent;
  if (agentId) {
    agent = await Agent.findById(agentId);
  } else if (toNum) {
    // Fallback: look up by phone number
    const phoneRecord = await PhoneNumber.findOne({ number: toNum }).populate('assignedAgent');
    agent = phoneRecord?.assignedAgent;
  }

  if (!agent) {
    console.warn(`[PlivoStream][${callUuid}] ⚠ No agent found. Hanging up.`);
    sendToPlivo(session.ws, { event: 'disconnect' });
    return false;
  }

  const user = await User.findById(agent.userId);

  session.agent        = agent;
  session.user         = user;
  session.userSettings = user?.settings || {};
  session.history      = [];
  session.isProcessing = false;
  session.agentSpeaking = false;
  session.currentGenerationId = null;
  session.status       = 'active';

  // --- Create call log ---
  const direction = params.direction || 'inbound';
  const callLog   = await CallLog.create({
    userId:     agent.userId,
    agentId:    agent._id,
    agentName:  agent.name,
    callSid:    callUuid,
    fromNumber: fromNum,
    toNumber:   toNum,
    direction,
    status:     'answered',
    startTime:  new Date(),
    transcript: [],
    provider:   'plivo',
  });
  session.callLogId = callLog._id;

  // --- Init Deepgram live STT ---
  const deepgramKey = session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
  const sttLang     = agent.language || 'en';

  session.deepgramConn = deepgramService.createLiveConnection({
    apiKey:   deepgramKey,
    language: sttLang === 'hi-Latn' ? 'hi' : sttLang,
    // Plivo sends mulaw 8000 Hz — Deepgram supports mulaw directly!
    audioConfig: {
      encoding:       'mulaw',
      sampleRate:     '8000',
      channels:       '1',
      audioInputMode: 'raw',
    },
    onTranscript: buildOnTranscript(session),
    onError:      (err) => console.error(`[PlivoStream][${callUuid}] Deepgram error:`, err?.message),
    onClose:      () => console.log(`[PlivoStream][${callUuid}] Deepgram closed`),
  });

  // --- Play greeting (first message) ---
  const greetingText = agent.firstMessage || 'Hello! How can I help you today?';
  session.history.push({ role: 'assistant', content: greetingText, timestamp: new Date() });
  await CallLog.findByIdAndUpdate(callLog._id, {
    $push: { transcript: { role: 'assistant', content: greetingText, timestamp: new Date() } },
  }).catch(() => {});

  // Generate greeting asynchronously so the call doesn't block
  speakAndPlay(session, greetingText, uuidv4()).catch(e => {
    console.error(`[PlivoStream][${callUuid}] Greeting TTS error:`, e.message);
  });

  console.log(`[PlivoStream][${callUuid}] ✅ Session ready. Agent: ${agent.name}. STT lang: ${sttLang}`);
  return true;
}

// ─── Deepgram transcript handler (Zoronal-style soft-commit) ─────────────────

function buildOnTranscript(session) {
  let softCommitBuffer = '';
  let softCommitTimer  = null;
  const COMMIT_MS      = 1000; // 1s silence = end of turn

  const flush = () => {
    clearTimeout(softCommitTimer);
    softCommitTimer = null;
    const text = softCommitBuffer.trim();
    softCommitBuffer = '';
    if (text.length < 2) return;

    // User is interrupting? Stop the current generation
    if (session.agentSpeaking) {
      stopInterrupt(session);
    }

    processUserTranscript(session, text).catch(e => {
      console.error(`[PlivoStream][${session.callUuid}] Transcript processing error:`, e.message);
    });
  };

  return ({ transcript, isFinal, speechFinal }) => {
    if (!transcript || !transcript.trim()) return;
    if (session.status === 'ended') return;

    // User speaking while agent is talking → interrupt detection
    if (session.agentSpeaking && transcript.trim().length > 6) {
      console.log(`[PlivoStream][${session.callUuid}] ⚡ Barge-in detected: "${transcript.trim().slice(0, 40)}"`);
    }

    if (isFinal && speechFinal) {
      // Merge into buffer
      softCommitBuffer = softCommitBuffer
        ? softCommitBuffer + ' ' + transcript.trim()
        : transcript.trim();

      clearTimeout(softCommitTimer);
      softCommitTimer = setTimeout(flush, COMMIT_MS);
    } else if (isFinal) {
      // Partial final — just reset the timer
      if (softCommitBuffer) {
        clearTimeout(softCommitTimer);
        softCommitTimer = setTimeout(flush, COMMIT_MS);
      }
    }
  };
}

// ─── Session cleanup ─────────────────────────────────────────────────────────

async function endSession(session, reason = 'call_ended') {
  if (session.status === 'ended') return;
  session.status = 'ended';

  console.log(`[PlivoStream][${session.callUuid}] 📴 Session ended: ${reason}`);

  // Cancel in-flight LLM
  if (session._currentAbortController) {
    try { session._currentAbortController.abort(); } catch (_) {}
    session._currentAbortController = null;
  }

  // Close Deepgram
  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
    session.deepgramConn = null;
  }

  // Finalize call log
  if (session.callLogId) {
    const endTime = new Date();
    await CallLog.findByIdAndUpdate(session.callLogId, {
      status:  'completed',
      endTime,
      duration: Math.round((endTime - (session.startTime || endTime)) / 1000),
    }).catch(() => {});
  }

  // Fire post-call webhook
  if (session.agent && session.callLogId) {
    webhookDispatcher.dispatchPostCallWebhook(session.agent, session.callLogId)
      .catch(e => console.error('[PlivoStream] Webhook error:', e.message));
  }

  plivoStreamSessions.delete(session.id);
}

// ─── Main WebSocket handler ───────────────────────────────────────────────────

/**
 * Called from server.js when a WebSocket upgrade is for /ws/plivo-stream.
 */
function handlePlivoStreamConnection(ws) {
  const sessionId = uuidv4();
  const session   = {
    id:       sessionId,
    ws,
    callUuid: null,
    streamId: null,
    status:   'connecting',
    startTime: Date.now(),
    agent:    null,
    user:     null,
    history:  [],
    deepgramConn: null,
    callLogId:    null,
    isProcessing: false,
    agentSpeaking: false,
    currentGenerationId: null,
    _currentAbortController: null,
    _pendingTranscript: null,
    _interruptLock: false,
    userSettings: {},
  };

  plivoStreamSessions.set(sessionId, session);
  console.log(`[PlivoStream] New WS connection (total: ${plivoStreamSessions.size})`);

  ws.on('message', async (rawData) => {
    let msg;
    try {
      msg = JSON.parse(rawData.toString());
    } catch (_) {
      return; // Ignore non-JSON (shouldn't happen)
    }

    const { event } = msg;

    switch (event) {
      case 'start': {
        try {
          const ok = await initSession(session, msg);
          if (!ok) ws.close(1000, 'no_agent');
        } catch (err) {
          console.error('[PlivoStream] Init error:', err.message);
          ws.close(1011, 'init_error');
        }
        break;
      }

      case 'media': {
        // Forward mulaw audio → Deepgram LIVE (no decoding needed!)
        if (session.deepgramConn && session.status === 'active') {
          try {
            const mulawBuf = Buffer.from(msg.media.payload, 'base64');
            session.deepgramConn.send(mulawBuf);
          } catch (_) {}
        }
        break;
      }

      case 'dtmf': {
        const digit = msg.dtmf?.digit || '';
        if (digit && session.status === 'active') {
          console.log(`[PlivoStream][${session.callUuid}] DTMF: ${digit}`);
          processUserTranscript(session, `[User pressed keypad: ${digit}]`).catch(() => {});
        }
        break;
      }

      case 'stop': {
        await endSession(session, 'call_ended');
        ws.close(1000, 'call_ended');
        break;
      }

      default:
        // Ignore unknown events (e.g. 'connected')
        break;
    }
  });

  ws.on('close', async (code, reason) => {
    console.log(`[PlivoStream] WS closed (code=${code})`);
    await endSession(session, 'ws_closed').catch(() => {});
    plivoStreamSessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    console.error('[PlivoStream] WS error:', err.message);
  });
}

module.exports = {
  handlePlivoStreamConnection,
  getPlivoStreamSessionCount: () => plivoStreamSessions.size,
};
