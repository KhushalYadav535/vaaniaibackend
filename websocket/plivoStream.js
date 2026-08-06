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
const ragService         = require('../services/ragService');
const plivoService       = require('../services/plivoService');

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
  console.warn('[PlivoStream] audio-decode not installed — will use ffmpeg for MP3→mulaw transcoding.');
}

/**
 * Convert an MP3 Buffer (from ElevenLabs/Edge-TTS) to mulaw 8000 Hz Buffer.
 * Primary: audio-decode (pure JS).
 * Fallback: ffmpeg (available on Linux VPS).
 *
 * @param {Buffer} mp3Buffer
 * @returns {Promise<Buffer>} mulaw buffer at 8000 Hz
 */
async function mp3ToMulaw8k(mp3Buffer) {
  if (!mp3Buffer || mp3Buffer.length === 0) return mp3Buffer;

  // --- Option A: audio-decode (pure JS, no native deps) ---
  if (audioDecode) {
    try {
      const decoded = await audioDecode(mp3Buffer);
      const sampleRate   = decoded.sampleRate   || 44100;
      const channelCount = decoded.channelCount  || 1;
      const numSamples   = decoded.length;

      const monoFloat32 = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        let sum = 0;
        for (let c = 0; c < channelCount; c++) sum += decoded.getChannelData(c)[i];
        monoFloat32[i] = sum / channelCount;
      }

      const pcm16Buf = Buffer.allocUnsafe(numSamples * 2);
      for (let i = 0; i < numSamples; i++) {
        const clamped = Math.max(-1, Math.min(1, monoFloat32[i]));
        pcm16Buf.writeInt16LE(Math.round(clamped * 32767), i * 2);
      }
      return pcm16BufferToMulaw8k(pcm16Buf, sampleRate);
    } catch (err) {
      console.error('[PlivoStream] audio-decode transcoding failed:', err.message);
    }
  }

  // --- Option B: ffmpeg (system binary, available on most Linux servers) ---
  try {
    const { execFile } = require('child_process');
    const mulawBuf = await new Promise((resolve, reject) => {
      const args = [
        '-f', 'mp3',       // input format
        '-i', 'pipe:0',    // read from stdin
        '-ar', '8000',     // sample rate 8kHz
        '-ac', '1',        // mono
        '-acodec', 'pcm_mulaw', // mulaw codec
        '-f', 'mulaw',     // output format
        'pipe:1',          // write to stdout
      ];
      const proc = execFile('ffmpeg', args, { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
      proc.stdin.write(mp3Buffer);
      proc.stdin.end();
    });
    console.log(`[PlivoStream] ffmpeg transcoded ${mp3Buffer.length}B MP3 → ${mulawBuf.length}B mulaw`);
    return mulawBuf;
  } catch (ffmpegErr) {
    console.error('[PlivoStream] ffmpeg transcoding failed:', ffmpegErr.message);
  }

  // --- Option C: raw fallback (will sound as noise, but at least won't crash) ---
  console.warn('[PlivoStream] Both audio-decode and ffmpeg failed — sending raw buffer (expect silence/noise)');
  return mp3Buffer;
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
  // Send clearAudio 3× with short gaps to aggressively flush Plivo's
  // ~200-500ms playback buffer. A single event is often ignored if
  // Plivo is mid-chunk; repeating it ensures the buffer drains fast.
  const clearEvt = { event: 'clearAudio', id: session.streamId || '' };
  sendToPlivo(session.ws, clearEvt);
  setTimeout(() => { if (session.ws?.readyState === 1) sendToPlivo(session.ws, clearEvt); }, 80);
  setTimeout(() => { if (session.ws?.readyState === 1) sendToPlivo(session.ws, clearEvt); }, 160);
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
  clearAudioOnPlivo(session);
}

// ─── Silence watchdog helpers ────────────────────────────────────────────────
// After the agent finishes speaking, if the user says nothing for SILENCE_WARN_MS,
// the agent nudges once. If still silent after SILENCE_HANGUP_MS, call ends.

const SILENCE_WARN_MS   = Number(process.env.PLIVO_SILENCE_WARN_MS   || 30000); // 30s
const SILENCE_HANGUP_MS = Number(process.env.PLIVO_SILENCE_HANGUP_MS || 20000); // +20s after warn
const MAX_CALL_MS       = Number(process.env.PLIVO_MAX_CALL_MS        || 10 * 60 * 1000); // 10 min hard cap

function clearSilenceWatchdog(session) {
  if (session._silenceWarnTimer)   { clearTimeout(session._silenceWarnTimer);   session._silenceWarnTimer   = null; }
  if (session._silenceHangupTimer) { clearTimeout(session._silenceHangupTimer); session._silenceHangupTimer = null; }
}

function startSilenceWatchdog(session) {
  clearSilenceWatchdog(session);
  if (session.status === 'ended') return;

  session._silenceWarnTimer = setTimeout(async () => {
    if (session.status === 'ended') return;
    console.log(`[PlivoStream][${session.callUuid}] 🔇 Silence warn — nudging user`);
    const warnMsg = session.agent.silenceWarningMessage ||
      'Are you still there? Is there anything else I can help you with?';
    const genId = uuidv4();
    session.currentGenerationId = genId;
    await speakAndPlay(session, warnMsg, genId).catch(() => {});

    // After the warning, give SILENCE_HANGUP_MS more before hanging up
    session._silenceHangupTimer = setTimeout(async () => {
      if (session.status === 'ended') return;
      console.log(`[PlivoStream][${session.callUuid}] 🔇 Silence hangup — ending call`);
      const byeMsg = session.agent.endCallMessage || 'Thank you for calling. Goodbye!';
      const genId2 = uuidv4();
      session.currentGenerationId = genId2;
      await speakAndPlay(session, byeMsg, genId2).catch(() => {});
      await endSession(session, 'silence_timeout');
    }, SILENCE_HANGUP_MS);

  }, SILENCE_WARN_MS);
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

    // --- RAG: fetch KB context in parallel before LLM ---
    const _ragStart = Date.now();
    const ragContext = await (
      (session.agent?.knowledgeBaseIds?.length > 0)
        ? ragService.getContextForQuery(text, session.agent.knowledgeBaseIds)
            .then(ctx => {
              if (ctx) console.log(`[PlivoStream][${session.callUuid}] RAG context retrieved (${Date.now() - _ragStart}ms)`);
              return ctx || '';
            })
            .catch(e => { console.error('[PlivoStream] RAG error:', e.message); return ''; })
        : Promise.resolve('')
    );

    // --- LLM Call ---
    const llmStart = Date.now();
    const aiResult = await voicePipeline.processText({
      text,
      agent:        session.agent,
      history:      session.history.slice(-12),
      userSettings: session.userSettings || {},
      abortSignal:  abortController.signal,
      ragContext,
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
      // Start silence watchdog — if user goes quiet after agent speaks,
      // we'll nudge them and eventually hang up.
      startSilenceWatchdog(session);
    } else if (!assistantText) {
      // LLM returned empty response — play a safe fallback so the caller
      // doesn't experience dead silence and wonder if the call dropped.
      console.warn(`[PlivoStream][${session.callUuid}] ⚠️ Empty LLM response — playing fallback`);
      const fallback = 'I\'m sorry, could you please repeat that?';
      const fbGenId = uuidv4();
      session.currentGenerationId = fbGenId;
      await speakAndPlay(session, fallback, fbGenId);
      startSilenceWatchdog(session);
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
 * Generate TTS audio, transcode to mulaw/8000 if needed, send to Plivo.
 * ElevenLabs now returns ulaw_8000 directly → no transcoding needed.
 * Other providers (edge-tts) return MP3 → transcode via ffmpeg.
 */
async function speakAndPlay(session, text, generationId) {
  if (!text || session.status === 'ended') return;
  try {
    const ttsStart  = Date.now();
    const agent     = session.agent;
    const provider  = agent.voice?.provider || 'edge-tts';

    const audioBuffer = await ttsService.textToSpeech({
      text,
      voiceId:      agent.voice?.voiceId  || 'en-IN-NeerjaNeural',
      provider,
      speed:        agent.voice?.speed    || 1.0,
      apiKey:       session.userSettings?.elevenLabsKey || process.env.ELEVENLABS_API_KEY,
      // Always request ulaw_8000 from ElevenLabs for Plivo (zero transcoding needed).
      // Web calls don't use plivoStream, so they safely default to MP3.
      outputFormat: provider === 'eleven-labs' ? 'ulaw_8000' : null,
    });

    // Detect actual audio format from magic bytes.
    // When ElevenLabs hits quota and falls back to Edge TTS internally,
    // provider='eleven-labs' but the buffer is MP3 — we must transcode it.
    // MP3: 0xFF 0xEx/0xFx, or starts with ID3 header (0x49 0x44 0x33)
    // WAV: starts with RIFF (0x52 0x49 0x46 0x46)
    // raw mulaw: no standard header, first bytes are audio data
    let mulawBuf;
    const b0 = audioBuffer[0], b1 = audioBuffer[1];
    const isMp3 = (b0 === 0xFF && (b1 & 0xE0) === 0xE0) ||  // MPEG sync
                  (b0 === 0x49 && b1 === 0x44);               // ID3 tag
    const isWav = b0 === 0x52 && b1 === 0x49;                 // RIFF

    if (isMp3 || isWav) {
      console.log(`[PlivoStream][${session.callUuid}] 🔄 Detected MP3/WAV, transcoding via ffmpeg...`);
      mulawBuf = await mp3ToMulaw8k(audioBuffer);
      console.log(`[PlivoStream][${session.callUuid}] 🔊 TTS transcoded (${Date.now() - ttsStart}ms, ${mulawBuf.length} bytes mulaw)`);
    } else {
      // Raw mulaw (ElevenLabs ulaw_8000 direct output)
      mulawBuf = audioBuffer;
      console.log(`[PlivoStream][${session.callUuid}] 🔊 TTS ulaw_8000 direct (${Date.now() - ttsStart}ms, ${mulawBuf.length} bytes)`);
    }

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
  // PRIMARY: URL query params (e.g. ?agentId=xxx&callUuid=yyy&from=zzz&to=www)
  // These are set by the inbound route when building the Stream WebSocket URL.
  // FALLBACK: Plivo's start event customParameters (unreliable — often empty)
  const urlP    = session.urlParams || {};
  const rawParams = startEvent.start?.customParameters || {};

  // Try to parse customParameters in case it was JSON-encoded
  let cpParams = rawParams;
  if (!cpParams.agentId) {
    for (const v of Object.values(rawParams)) {
      try { const p = JSON.parse(v); if (p?.agentId) { cpParams = p; break; } } catch (_) {}
    }
  }

  // Merge: URL params take priority
  const agentId  = urlP.agentId  || cpParams.agentId;
  const callUuid = urlP.callUuid || cpParams.callUuid || startEvent.start?.callId || '';
  const fromNum  = urlP.from     || cpParams.from     || '';
  const toNum    = urlP.to       || cpParams.to       || '';

  session.callUuid  = callUuid;
  session.streamId  = startEvent.start?.streamId || '';
  session.fromNum   = fromNum;
  session.toNum     = toNum;

  console.log(`[PlivoStream][${callUuid}] 📞 Call started. AgentId=${agentId || 'lookup'} To=${toNum} From=${fromNum}`);
  console.log(`[PlivoStream] urlParams:`, JSON.stringify(urlP));

  // --- Resolve agent ---
  let agent;
  if (agentId && agentId !== 'undefined') {
    agent = await Agent.findById(agentId).catch(() => null);
  }
  
  if (!agent && toNum) {
    // Fallback: look up by phone number (normalize +/without +)
    const normalizedTo = toNum.replace(/^\+/, '');
    const phoneRecord = await PhoneNumber.findOne({
      number: { $in: [normalizedTo, `+${normalizedTo}`] }
    }).populate('assignedAgent');
    agent = phoneRecord?.assignedAgent || null;
    if (agent) console.log(`[PlivoStream][${callUuid}] Agent found via PhoneNumber lookup: ${agent.name}`);
  }

  if (!agent) {
    console.warn(`[PlivoStream][${callUuid}] ⚠ No agent found. agentId=${agentId} toNum=${toNum}. Hanging up.`);
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
  const direction = urlP.direction || cpParams.direction || 'inbound';
  const callLog   = await CallLog.create({
    userId:     agent.userId,
    agentId:    agent._id,
    agentName:  agent.name,
    callSid:    callUuid,
    fromNumber: fromNum,
    toNumber:   toNum,
    direction,
    status:     'ongoing',
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

  // Generate greeting — set currentGenerationId first so the guard in speakAndPlay
  // doesn't reject it (guard: session.currentGenerationId !== generationId).
  const greetingGenId = uuidv4();
  session.currentGenerationId = greetingGenId;
  speakAndPlay(session, greetingText, greetingGenId).catch(e => {
    console.error(`[PlivoStream][${callUuid}] Greeting TTS error:`, e.message);
  });

  console.log(`[PlivoStream][${callUuid}] ✅ Session ready. Agent: ${agent.name}. STT lang: ${sttLang}`);

  // Hard max-duration watchdog — terminates zombie calls that never end cleanly.
  // Default 10 minutes, configurable via PLIVO_MAX_CALL_MS env.
  session._maxDurationTimer = setTimeout(async () => {
    if (session.status === 'ended') return;
    console.warn(`[PlivoStream][${callUuid}] ⏰ Max call duration reached — force ending`);
    const byeMsg = session.agent?.endCallMessage || 'Thank you for calling. Goodbye!';
    const genId  = uuidv4();
    session.currentGenerationId = genId;
    await speakAndPlay(session, byeMsg, genId).catch(() => {});
    await endSession(session, 'max_duration');
  }, MAX_CALL_MS);

  return true;
}

// ─── Deepgram transcript handler (Zoronal-style soft-commit) ─────────────────

function buildOnTranscript(session) {
  let softCommitBuffer = '';
  let softCommitTimer  = null;
  const COMMIT_MS      = Number(process.env.PLIVO_COMMIT_MS || 750); // ms silence = end of turn (env-configurable)

  const flush = () => {
    clearTimeout(softCommitTimer);
    softCommitTimer = null;
    const text = softCommitBuffer.trim();
    softCommitBuffer = '';
    if (text.length < 2) return;

    // If a barge-in fired very recently (< 300ms ago), the committed text
    // likely overlaps with what the agent was saying — discard it to avoid
    // the agent answering its own interrupted speech as if it were a user query.
    const bargeInAge = session._lastBargeInAt ? Date.now() - session._lastBargeInAt : Infinity;
    if (bargeInAge < 300) {
      console.log(`[PlivoStream][${session.callUuid}] ⚡ Discarding stale post-barge-in text: "${text.slice(0, 40)}"`);
      return;
    }

    processUserTranscript(session, text).catch(e => {
      console.error(`[PlivoStream][${session.callUuid}] Transcript processing error:`, e.message);
    });
  };

  return ({ transcript, isFinal, speechFinal }) => {
    if (!transcript || !transcript.trim()) return;
    if (session.status === 'ended') return;

    const trimmed = transcript.trim();

    // Reset silence watchdog — user spoke, so they're still active
    clearSilenceWatchdog(session);

    // ── Barge-in: interrupt agent immediately when user starts speaking ─────
    // Threshold is >1 char (not >3) so even a short "ha"/"ok" fires instantly.
    // _lastBargeInAt is set so flush() can discard the stale overlapping text.
    if (session.agentSpeaking && trimmed.length > 1) {
      console.log(`[PlivoStream][${session.callUuid}] ⚡ Barge-in! Stopping agent. User: "${trimmed.slice(0, 40)}"`);
      session._lastBargeInAt = Date.now();
      stopInterrupt(session);
    }

    if (isFinal && speechFinal) {
      // Merge into buffer
      softCommitBuffer = softCommitBuffer
        ? softCommitBuffer + ' ' + trimmed
        : trimmed;

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

  // Clear all watchdog timers so they don't fire on a dead session
  clearSilenceWatchdog(session);
  if (session._maxDurationTimer) { clearTimeout(session._maxDurationTimer); session._maxDurationTimer = null; }

  // Close Deepgram
  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
    session.deepgramConn = null;
  }

  // ── Server-side call termination ─────────────────────────────────────────
  // When our server decides to end the call (user said bye, agent ended it,
  // or session timed out), we terminate the live Plivo call via REST API.
  // This is the equivalent of "hanging up" from our side.
  // Skip if reason is 'ws_closed' or 'call_ended' — Plivo already hung up in that case.
  const shouldHangup = session.callUuid &&
    !['ws_closed', 'call_ended'].includes(reason);

  if (shouldHangup) {
    plivoService.hangupCall(session.user, session.callUuid)
      .then(() => console.log(`[PlivoStream][${session.callUuid}] ✅ Plivo call terminated (${reason})`))
      .catch(e  => console.warn(`[PlivoStream][${session.callUuid}] ⚠️ Hangup API failed (${reason}): ${e.message}`));
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
function handlePlivoStreamConnection(ws, request) {
  // Parse URL query params — this is how we pass agentId, callUuid etc.
  // e.g. /ws/plivo-stream?agentId=xxx&callUuid=yyy&from=zzz&to=www
  const urlParams = {};
  try {
    const fullUrl = `http://localhost${request?.url || ''}`;
    const parsed  = new URL(fullUrl);
    for (const [k, v] of parsed.searchParams.entries()) urlParams[k] = v;
  } catch (_) {}

  const sessionId = uuidv4();
  const session   = {
    id:       sessionId,
    ws,
    urlParams, // available to initSession
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
