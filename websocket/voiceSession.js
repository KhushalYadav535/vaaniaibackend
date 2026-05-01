/**
 * WebSocket Voice Session Handler
 * 
 * Handles real-time browser voice testing:
 * Browser Mic → WebSocket (PCM audio) → Deepgram STT → Groq LLM → Edge TTS → WebSocket (MP3) → Browser speaker
 * 
 * Protocol:
 * Client sends: { type: 'init', agentId, token } to start session
 * Client sends: { type: 'audio', data: base64AudioChunk } for audio data
 * Client sends: { type: 'end_audio' } when speaking stops (for batch STT)
 * Client sends: { type: 'text', text: '...' } for text input (testing without mic)
 * Client sends: { type: 'end_session' } to end call
 * 
 * Server sends: { type: 'ready', sessionId, firstMessage } when initialized
 * Server sends: { type: 'transcript', text, isFinal } as user speaks
 * Server sends: { type: 'response_text', text } when AI response ready
 * Server sends: { type: 'audio', data: base64AudioChunk } for TTS audio
 * Server sends: { type: 'audio_end' } when audio chunk done
 * Server sends: { type: 'status', message } for status updates
 * Server sends: { type: 'error', message } for errors
 * Server sends: { type: 'session_ended', summary } when call ends
 */

const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const Agent = require('../models/Agent');
const User = require('../models/User');
const CallLog = require('../models/CallLog');
const voicePipeline = require('../services/voicePipeline');
const deepgramService = require('../services/deepgramService');
const notificationService = require('../services/notificationService');
const ragService = require('../services/ragService');
const CallFlow = require('../models/CallFlow');
const callFlowEngine = require('../services/callFlowEngine');
const webhookDispatcher = require('../services/webhookDispatcher');
const ttsService = require('../services/ttsService');

// Track active sessions
const activeSessions = new Map();

function setupVoiceSession(wss) {
  wss.on('connection', (ws) => {
    const sessionId = uuidv4();
    let session = {
      id: sessionId,
      traceId: sessionId,
      ws,
      userId: null,
      agent: null,
      userSettings: {},
      history: [],
      startTime: Date.now(),
      audioBuffer: [],  // Accumulate audio chunks
      deepgramConn: null,
      callLogId: null,
      isProcessing: false,
      status: 'connected',
      currentGenerationId: null, // Track current AI generation
      fullAudioBuffer: [], // Accumulate audio for recording
      latency: {
        turnStartedAt: null,
        llmStartedAt: null,
        firstTextChunkAt: null,
        firstAudioAt: null,
      },
      callLogWriteQueue: Promise.resolve(),
      prefersBinaryAudio: false,
      sttUnavailable: false,
      audioIngressWindowStartedAt: Date.now(),
      audioIngressBytesInWindow: 0,
      droppedAudioChunks: 0,
      warnedBackpressureAt: 0,
      sttRetryAttempted: false,
    };

    activeSessions.set(sessionId, session);
    console.log(`🔌 WebSocket connected: ${sessionId}`);

    // Send ready ping
    safeSend(ws, { type: 'connected', sessionId });

    ws.on('message', async (rawData, isBinary) => {
      try {
        if (isBinary) {
          await handleAudioChunkBinary(session, rawData);
          return;
        }
        const message = JSON.parse(rawData.toString());
        await handleMessage(session, message);
      } catch (error) {
        console.error(`❌ Session ${sessionId} error:`, error.message);
        safeSend(ws, { type: 'error', message: error.message });
      }
    });

    ws.on('close', async () => {
      await cleanupSession(session);
      activeSessions.delete(sessionId);
      console.log(`🔌 WebSocket disconnected: ${sessionId}`);
    });

    ws.on('error', (err) => {
      console.error(`❌ WebSocket error ${sessionId}:`, err.message);
    });
  });
}

async function handleMessage(session, message) {
  const { type } = message;

  switch (type) {
    case 'init':
      await handleInit(session, message);
      break;

    case 'audio':
      // Streaming audio chunks from browser mic
      await handleAudioChunk(session, message);
      break;

    case 'mic_config':
      // Browser reports actual AudioContext sample rate — reinitialize Deepgram with correct config
      await handleMicConfig(session, message);
      break;

    case 'end_audio':
      // User stopped speaking - process accumulated audio
      await handleAudioEnd(session);
      break;

    case 'text':
      // Text input for testing without microphone
      await handleTextInput(session, message.text);
      break;

    case 'end_session':
      await handleEndSession(session, 'user_hangup');
      break;

    case 'ping':
      safeSend(session.ws, { type: 'pong' });
      break;

    default:
      console.warn('Unknown message type:', type);
  }
}

async function handleMicConfig(session, message) {
  const { sampleRate, encoding = 'linear16', channels = 1 } = message;
  if (!sampleRate || !session.agent || !session.enableStt) return;

  const configuredRate = Number(process.env.DEEPGRAM_SAMPLE_RATE || 48000);
  const configuredEncoding = process.env.DEEPGRAM_ENCODING || 'linear16';

  console.log(`[MicConfig] Browser: ${encoding}@${sampleRate}Hz | Deepgram configured: ${configuredEncoding}@${configuredRate}Hz`);

  // If the rates already match, DON'T reinitialize — the handleInit connection is already
  // open and working. Reinitializing would close it and drop audio during reconnect.
  if (sampleRate === configuredRate && encoding === configuredEncoding) {
    console.log(`[MicConfig] Rates match — keeping existing Deepgram connection ✅`);
    safeSend(session.ws, { type: 'status', message: `🎙️ STT ready (${sampleRate}Hz)` });
    return;
  }

  // Rates mismatch — need to reinitialize with correct rate
  console.log(`[MicConfig] Rate mismatch — reinitializing Deepgram connection...`);

  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
    session.deepgramConn = null;
  }

  session.sttUnavailable = false;
  session.sttRetryAttempted = false;

  const deepgramKey = session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
  const sttLanguage = session.agent.language || 'en';

  // Temporarily override env vars for this connection
  const origEncoding = process.env.DEEPGRAM_ENCODING;
  const origSampleRate = process.env.DEEPGRAM_SAMPLE_RATE;
  const origChannels = process.env.DEEPGRAM_CHANNELS;
  const origMode = process.env.DEEPGRAM_AUDIO_INPUT_MODE;

  process.env.DEEPGRAM_ENCODING = encoding;
  process.env.DEEPGRAM_SAMPLE_RATE = String(sampleRate);
  process.env.DEEPGRAM_CHANNELS = String(channels);
  process.env.DEEPGRAM_AUDIO_INPUT_MODE = 'raw';

  session.deepgramConn = deepgramService.createLiveConnection({
    apiKey: deepgramKey,
    language: sttLanguage,
    backgroundDenoising: session.agent.advanced?.backgroundDenoising || 'default',
    onTranscript: async ({ transcript, isFinal, speechFinal }) => {
      safeSend(session.ws, { type: 'transcript', text: transcript, isFinal: false, role: 'user' });

      const sensitivity = session.agent.advanced?.interruptionSensitivity ?? 0.5;
      const interruptThreshold = Math.max(1, Math.round(15 * (1 - sensitivity)));
      if (transcript.length >= interruptThreshold) {
        safeSend(session.ws, { type: 'interrupt' });
      }

      if (isFinal && speechFinal && transcript.trim().length > 0) {
        if (session.isProcessing) return;
        session.isProcessing = true;
        session.latency.turnStartedAt = Date.now();
        session.latency.llmStartedAt = null;
        session.latency.firstTextChunkAt = null;
        session.latency.firstAudioAt = null;
        try {
          await processTranscript(session, transcript);
        } catch (e) {
          console.error('Error processing mic_config live transcript:', e);
          session.isProcessing = false;
        }
      }
    },
    onError: (err) => {
      console.error('[MicConfig] Deepgram error after mic_config:', err.message);
      session.sttUnavailable = true;
      safeSend(session.ws, { type: 'error', message: `STT error: ${err.message}` });
    },
    onClose: (closeInfo) => {
      if (closeInfo?.code && closeInfo.code !== 1000) {
        console.log(`[MicConfig] Deepgram closed: code=${closeInfo.code}`);
      }
    },
  });

  // Restore env vars
  process.env.DEEPGRAM_ENCODING = origEncoding;
  process.env.DEEPGRAM_SAMPLE_RATE = origSampleRate;
  process.env.DEEPGRAM_CHANNELS = origChannels;
  process.env.DEEPGRAM_AUDIO_INPUT_MODE = origMode;

  console.log(`[MicConfig] Deepgram reinitialized: ${encoding}@${sampleRate}Hz`);
  safeSend(session.ws, { type: 'status', message: `🎙️ STT ready (${sampleRate}Hz)` });
}


async function handleInit(session, message) {
  const { agentId, token, preferBinaryAudio, enableStt = true, skipPostCallAnalysis = false } = message;

  // Verify JWT token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new Error('Invalid or expired token. Please log in again.');
  }

  // Load user
  const user = await User.findById(decoded.id);
  if (!user) throw new Error('User not found');

  // Load agent - widget tokens include agentId and bypass ownership check
  let agent;
  if (decoded.type === 'widget') {
    agent = await Agent.findOne({ _id: decoded.agentId, status: 'active' });
    if (!agent) throw new Error('Agent not found or inactive');
  } else {
    agent = await Agent.findOne({ _id: agentId, userId: user._id });
    if (!agent) throw new Error('Agent not found or not authorized');
  }

  session.userId = user._id;
  session.agent = agent;
  session.userSettings = user.settings || {};
  session.prefersBinaryAudio = !!preferBinaryAudio;
  session.enableStt = enableStt !== false;
  session.skipPostCallAnalysis = !!skipPostCallAnalysis;
  session.status = 'ready';
  
  if (agent.workflowId) {
    session.callFlow = await CallFlow.findById(agent.workflowId);
    if (session.callFlow) {
      console.log(`[Flow] Loaded Call Flow: ${session.callFlow.name}`);
    }
  }
  
  // Fetch User Memory (Retell/Vapi style)
  const UserMemory = require('../models/UserMemory');
  const userPhone = session.callParams?.from || 'test_user'; // Default for test agent
  const memory = await UserMemory.findOne({ userId: user._id, phone: userPhone });
  session.memory = memory;

  if (session.enableStt) {
    // Set up live Deepgram Connection for continuous transcription
    const deepgramKey = session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
      throw new Error('⚠️ No Deepgram API key configured. Please add DEEPGRAM_API_KEY to your .env file. Get $200 free credits at https://deepgram.com');
    }
    
    // Validate API key format - Deepgram supports two formats:
    // Legacy: 40-char hex (e.g. 7ee245f531db82f59df59ecae82f906f5eac89e1)
    // New: sk-xxx format
    if (deepgramKey.length < 20) {
      console.warn('⚠️ Deepgram API key appears to be too short. Please check your .env configuration.');
      safeSend(session.ws, {
        type: 'status',
        message: '⚠️ Deepgram API key appears invalid. Please check your configuration.',
      });
    }

    // Use the agent's configured language for STT (hindi = 'hi', english = 'en', multilingual = 'multi')
    const sttLanguage = agent.language || 'en';
    console.log(`🌐 Agent language: ${sttLanguage}`);

  session.deepgramConn = deepgramService.createLiveConnection({
      apiKey: deepgramKey,
      language: sttLanguage,
      backgroundDenoising: agent.advanced?.backgroundDenoising || 'default',
      onTranscript: async ({ transcript, isFinal, speechFinal }) => {
        // ── Interruption detection: if user speaks while agent is talking ──
        if (session.agentSpeaking) {
          const sensitivity = agent.advanced?.interruptionSensitivity ?? 0.5;
          const interruptThreshold = Math.max(2, Math.round(12 * (1 - sensitivity)));

          // Only interrupt if the user actually said something meaningful (not mic echo)
          if (transcript.trim().length >= interruptThreshold) {
            console.log(`[Interrupt] User spoke during agent TTS: "${transcript.trim().substring(0, 60)}"`);

            // 1. Cancel current generation so LLM stream loop exits
            session.currentGenerationId = uuidv4();

            // 2. Clear agentSpeaking so new processing can start
            session.agentSpeaking = false;
            if (session._agentSpeakingTimer) { clearTimeout(session._agentSpeakingTimer); session._agentSpeakingTimer = null; }

            // 3. Reset processing flag — the old pipeline will exit via generationId mismatch
            session.isProcessing = false;

            // 4. Tell client to stop playing any queued audio immediately
            safeSend(session.ws, { type: 'interrupt' });
            safeSend(session.ws, { type: 'clear_audio' });

            // 5. Treat this transcript as the new user turn
            session._lastSttTranscript = transcript;

            // If this is a final/speechFinal, process immediately
            if (isFinal && speechFinal && transcript.trim().length > 0) {
              if (session._silenceTimer) { clearTimeout(session._silenceTimer); session._silenceTimer = null; }
              session.isProcessing = true;
              session.latency.turnStartedAt = Date.now();
              session.latency.llmStartedAt = null;
              session.latency.firstTextChunkAt = null;
              session.latency.firstAudioAt = null;
              console.log(`[STT] Interrupt speech_final: "${transcript}"`);
              try {
                await processTranscript(session, transcript);
              } catch (e) {
                console.error('Error processing interrupt transcript:', e);
                session.isProcessing = false;
              }
              return;
            }

            // Otherwise start silence timer for this interrupted input
            if (session._silenceTimer) clearTimeout(session._silenceTimer);
            session._silenceTimer = setTimeout(async () => {
              session._silenceTimer = null;
              const pending = session._lastSttTranscript;
              if (!pending || pending.trim().length < 2) return;
              if (session.isProcessing) return;
              session._lastSttTranscript = '';
              session.isProcessing = true;
              session.latency.turnStartedAt = Date.now();
              session.latency.llmStartedAt = null;
              session.latency.firstTextChunkAt = null;
              session.latency.firstAudioAt = null;
              console.log(`[STT] Interrupt silence-timer: "${pending}"`);
              try {
                await processTranscript(session, pending);
              } catch (e) {
                console.error('Error processing interrupt silence-timer transcript:', e);
                session.isProcessing = false;
              }
            }, 900);
          }
          // Whether we interrupted or not, don't fall through to normal processing
          return;
        }

        // Always forward interim results to show live speech in UI
        safeSend(session.ws, {
           type: 'transcript',
           text: transcript,
           isFinal: false,
           role: 'user',
        });

        // Track latest transcript for silence-timer fallback
        if (transcript.trim().length > 0) {
          session._lastSttTranscript = transcript;
        }

        // ─── Path 1: Deepgram speech_final (works when account supports it) ───
        if (isFinal && speechFinal && transcript.trim().length > 0) {
          if (session._silenceTimer) { clearTimeout(session._silenceTimer); session._silenceTimer = null; }
          if (session.isProcessing) return;
          session.isProcessing = true;
          session.latency.turnStartedAt = Date.now();
          session.latency.llmStartedAt = null;
          session.latency.firstTextChunkAt = null;
          session.latency.firstAudioAt = null;
          console.log(`[STT] speech_final triggered: "${transcript}"`);
          try {
            await processTranscript(session, transcript);
          } catch (e) {
            console.error("Error processing live transcript:", e);
            session.isProcessing = false;
          }
          return;
        }

        // ─── Path 2: Client-side silence timer fallback ───────────────
        if (session._silenceTimer) clearTimeout(session._silenceTimer);
        session._silenceTimer = setTimeout(async () => {
          session._silenceTimer = null;
          if (session.agentSpeaking) return;
          const pending = session._lastSttTranscript;
          if (!pending || pending.trim().length < 2) return;
          if (session.isProcessing) return;
          session._lastSttTranscript = '';
          session.isProcessing = true;
          session.latency.turnStartedAt = Date.now();
          session.latency.llmStartedAt = null;
          session.latency.firstTextChunkAt = null;
          session.latency.firstAudioAt = null;
          console.log(`[STT] silence-timer triggered: "${pending}"`);
          try {
            await processTranscript(session, pending);
          } catch (e) {
            console.error("Error processing silence-timer transcript:", e);
            session.isProcessing = false;
          }
        }, 1200);

      },
    onError: (err) => {
      session.sttUnavailable = true;
      safeSend(session.ws, {
        type: 'error',
        message: `Deepgram Error: ${err?.message || 'Live transcription unavailable'}`,
      });
      safeSend(session.ws, {
        type: 'status',
        message: 'STT temporarily unavailable. You can continue in text mode.',
      });
      trySttFallbackReconnect(session, deepgramKey);
    },
    onClose: (closeInfo) => {
      if (closeInfo && closeInfo.code && closeInfo.code !== 1000) {
        safeSend(session.ws, {
          type: 'status',
          message: `STT connection closed (code ${closeInfo.code}).`,
        });
      }
    },
    });
  }

  // Create initial call log
  const callLog = await CallLog.create({
    userId: user._id,
    agentId: agent._id,
    agentName: agent.name,
    direction: 'web',
    status: 'ongoing',
    sessionId: session.id,
    startTime: new Date(),
    transcript: [],
  });
  session.callLogId = callLog._id;

  safeSend(session.ws, {
    type: 'status',
    message: '🎙️ Agent initialized. Generating greeting...'
  });

  // Get first message audio
  try {
    let firstMessageText = '';
    
    if (session.callFlow) {
      // Execute the first nodes of the CallFlow
      const stream = callFlowEngine.processFlowStep(session, '', session.callFlow);
      for await (const chunk of stream) {
        if (chunk.type === 'chunk') {
           firstMessageText += chunk.text + ' ';
        } else if (chunk.type === 'transfer') {
           // Handle immediate transfer if any
           safeSend(session.ws, { type: 'transfer_initiated', transferTo: chunk.transferTo, reason: chunk.reason });
           return;
        } else if (chunk.type === 'end_call') {
           handleEndSession(session, 'flow_ended');
           return;
        }
      }
      
      firstMessageText = firstMessageText.trim();
      if (!firstMessageText) firstMessageText = "Hello."; // Fallback if flow had no speak node
      
      const ttsService = require('../services/ttsService');
      const audioBuffer = await ttsService.textToSpeech({
        text: firstMessageText,
        voiceId: agent.voice?.voiceId || 'en-US-JennyNeural',
        provider: agent.voice?.provider || 'edge-tts',
      });
      
      // Add to history
      session.history.push({ role: 'assistant', content: firstMessageText, timestamp: new Date() });
      queueCallLogUpdate(session, {
        $push: { transcript: { role: 'assistant', content: firstMessageText } }
      }, 'first_message_flow');

      safeSend(session.ws, { 
        type: 'response_text', 
        text: firstMessageText, 
        isFirstMessage: true,
        ambientNoise: agent.advanced?.ambientNoise || 'none'
      });

      if (audioBuffer && audioBuffer.length > 0) {
        sendAudioBuffer(session, audioBuffer);
      }
    } else {
      // Standard Voice Pipeline
      const { text, audioBuffer } = await voicePipeline.getFirstMessageAudio(agent);
      firstMessageText = text;

      // Add to history
      session.history.push({ role: 'assistant', content: text, timestamp: new Date() });

      // Update call log
      queueCallLogUpdate(session, {
        $push: { transcript: { role: 'assistant', content: text } }
      }, 'first_message_standard');

      // Send text first with ambient noise config
      safeSend(session.ws, { 
        type: 'response_text', 
        text, 
        isFirstMessage: true,
        ambientNoise: agent.advanced?.ambientNoise || 'none'
      });

      // Send audio
      if (audioBuffer && audioBuffer.length > 0) {
        sendAudioBuffer(session, audioBuffer);
      }
    }

    safeSend(session.ws, {
      type: 'ready',
      sessionId: session.id,
      agentName: agent.name,
      firstMessage: firstMessageText,
      ambientNoise: agent.advanced?.ambientNoise || 'none',
    });

    session.status = 'listening';

  } catch (error) {
    throw new Error('Failed to initialize agent: ' + error.message);
  }
}

async function handleAudioChunk(session, message) {
  if (!session.agent || !session.deepgramConn || session.sttUnavailable) return;

  // Stream directly to deepgram
  const audioData = Buffer.from(message.data, 'base64');
  if (!allowAudioIngress(session, audioData.length)) return;
  try {
    session.deepgramConn.send(audioData);
  } catch (e) {
    console.error("Failed to send chunk to deepgram:", e);
  }
}

async function handleAudioChunkBinary(session, rawData) {
  if (!session.agent || !session.deepgramConn || session.sttUnavailable) return;

  try {
    const audioData = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    if (!allowAudioIngress(session, audioData.length)) return;
    session.deepgramConn.send(audioData);
  } catch (e) {
    console.error("Failed to send binary chunk to deepgram:", e);
  }
}

async function handleAudioEnd(session) {
  // Obsolete in Live mode, but keeping endpoint for graceful stop
}

async function handleTextInput(session, text) {
  if (!session.agent) {
    throw new Error('Session not initialized. Please send an init message first.');
  }
  if (!text || typeof text !== 'string' || text.trim() === '') return;
  if (session.isProcessing) return;

  session.isProcessing = true;
  session.latency.turnStartedAt = Date.now();
  session.latency.llmStartedAt = null;
  session.latency.firstTextChunkAt = null;
  session.latency.firstAudioAt = null;
  await processTranscript(session, text.trim());
}

async function processTranscript(session, transcript) {
  try {
    // Cancel any ongoing generation
    const generationId = uuidv4();
    session.currentGenerationId = generationId;

    // Send transcript to client
    safeSend(session.ws, {
      type: 'transcript',
      text: transcript,
      isFinal: true,
      role: 'user',
    });

    // Handle Backchanneling (Vapi/Retell style)
    if (session.agent.advanced?.backchanneling) {
      const backchannel = voicePipeline.getBackchannel(transcript);
      if (backchannel) {
        console.log(`[Backchannel] Sending: ${backchannel}`);
        const audio = await ttsService.textToSpeech({
          text: backchannel,
          voiceId: session.agent.voice?.voiceId,
          speed: 1.2, // Slightly faster for backchannels
          apiKey: session.userSettings.ttsKey || process.env.ELEVENLABS_API_KEY,
          provider: session.agent.voice?.provider || 'edge-tts',
        });
        if (audio) sendAudioBuffer(session, audio);
      }
    }

    // Check for end call
    if (voicePipeline.shouldEndCall(transcript, session.agent)) {
      await handleEndSession(session, 'user_hangup');
      return;
    }

    // Add user message to history
    session.history.push({ role: 'user', content: transcript, timestamp: new Date() });

    // Update call log
    queueCallLogUpdate(session, {
      $push: { transcript: { role: 'user', content: transcript } }
    }, 'user_transcript');

    // 🔴 REAL-TIME SENTIMENT ANALYSIS (non-blocking)
    // Run sentiment classification in background — don't block the LLM pipeline
    voicePipeline.classifySentiment(transcript).then(async (sentimentResult) => {
      // Send live sentiment to frontend
      safeSend(session.ws, {
        type: 'sentiment',
        sentiment: sentimentResult.sentiment,
        score: sentimentResult.score,
        text: transcript.substring(0, 100), // First 100 chars
      });

      // Track sentiment history on session for transfer checks
      if (!session.sentimentHistory) session.sentimentHistory = [];
      session.sentimentHistory.push({
        sentiment: sentimentResult.sentiment,
        score: sentimentResult.score,
        timestamp: new Date(),
      });

      // Save to call log sentiment timeline
      if (session.callLogId) {
        await CallLog.findByIdAndUpdate(session.callLogId, {
          $push: {
            liveSentimentTimeline: {
              timestamp: new Date(),
              sentiment: sentimentResult.sentiment,
              score: sentimentResult.score,
              text: transcript.substring(0, 200),
            },
          },
        }).catch(e => console.error('Sentiment save error:', e.message));
      }
    }).catch(e => console.error('Sentiment analysis error:', e.message));

    // 🔄 HUMAN HANDOFF CHECK
    // Check if call should be transferred to a human agent
    if (session.agent?.transferNumber) {
      const transferCheck = voicePipeline.shouldTransfer({
        transcript: session.history,
        sentimentHistory: session.sentimentHistory || [],
        agent: session.agent,
      });

      if (transferCheck.shouldTransfer) {
        console.log(`[🔄 Transfer] Session ${session.id} → ${session.agent.transferNumber} (${transferCheck.reason})`);

        // Send transfer event to frontend
        safeSend(session.ws, {
          type: 'transfer_initiated',
          transferTo: session.agent.transferNumber,
          reason: transferCheck.reason,
          context: `Call transferred after ${session.history.length} messages. Reason: ${transferCheck.reason}`,
        });

        // Update call log
        if (session.callLogId) {
          await CallLog.findByIdAndUpdate(session.callLogId, {
            transferredTo: session.agent.transferNumber,
            transferReason: transferCheck.reason,
          }).catch(e => console.error('Transfer log error:', e.message));
        }

        // Say transfer message and end
        const transferMsg = `I'm going to connect you with a team member who can better assist you. Please hold for a moment.`;
        safeSend(session.ws, { type: 'response_text', text: transferMsg });

        try {
          const ttsService = require('../services/ttsService');
          const audioBuffer = await ttsService.textToSpeech({
            text: transferMsg,
            voiceId: session.agent.voice?.voiceId || 'en-US-JennyNeural',
            provider: session.agent.voice?.provider || 'edge-tts',
          });
          if (audioBuffer && audioBuffer.length > 0) {
            sendAudioBuffer(session, audioBuffer);
          }
        } catch (e) {}

        // End session after transfer message
        setTimeout(() => handleEndSession(session, 'transferred'), 3000);
        return;
      }
    }

    // Store sentiment history on session for transfer checks
    if (!session.sentimentHistory) session.sentimentHistory = [];

    safeSend(session.ws, { type: 'status', message: '💭 AI is thinking...' });
    session.latency.llmStartedAt = Date.now();

    // Fetch RAG context if agent has a Knowledge Base
    let ragContext = '';
    if (session.agent?.knowledgeBaseId) {
      try {
        ragContext = await ragService.getContextForQuery(transcript, session.agent.knowledgeBaseId);
        if (ragContext) {
          console.log(`[RAG] Retrieved context for session ${session.id}`);
        }
      } catch (e) {
        console.error(`[RAG] Context retrieval error:`, e.message);
      }
    }

    // Process through voice pipeline using STREAMING (Much faster) or Call Flow Engine
    let stream;
    if (session.callFlow) {
      stream = callFlowEngine.processFlowStep(session, transcript, session.callFlow);
    } else {
      stream = voicePipeline.processTextStream({
        text: transcript,
        agent: session.agent,
        history: session.history.slice(-10),
        userSettings: session.userSettings,
        memory: session.memory,
        ragContext
      });
    }

    let fullResponseText = '';
    
    for await (const chunk of stream) {
      // If a new generation has started, stop this one immediately
      if (session.currentGenerationId !== generationId) {
        console.log(`[Interrupt] Stopping old generation: ${generationId}`);
        return;
      }

      if (chunk.type === 'chunk') {
        // Re-check after async TTS — user may have interrupted during TTS generation
        if (session.currentGenerationId !== generationId) {
          console.log(`[Interrupt] Aborting chunk send for old generation: ${generationId}`);
          return;
        }

        if (!session.latency.firstTextChunkAt) {
          session.latency.firstTextChunkAt = Date.now();
          emitLatencyMetrics(session, 'first_text_chunk');
        }

        // Send this sentence's text and audio immediately
        safeSend(session.ws, {
          type: 'response_text_chunk',
          text: chunk.text,
        });

        fullResponseText += chunk.text + ' ';

        let audioToPlay = chunk.audio;
        if (!audioToPlay && session.callFlow && chunk.text) {
           const ttsService = require('../services/ttsService');
           try {
              audioToPlay = await ttsService.textToSpeech({
                 text: chunk.text,
                 voiceId: session.agent.voice?.voiceId || 'en-US-JennyNeural',
                 provider: session.agent.voice?.provider || 'edge-tts',
              });
           } catch (e) {
              console.error('[Flow TTS Error]', e);
           }
        }

        // Final interrupt check before sending audio
        if (session.currentGenerationId !== generationId) {
          console.log(`[Interrupt] Aborting audio send for old generation: ${generationId}`);
          return;
        }

        if (audioToPlay && audioToPlay.length > 0) {
           sendAudioBuffer(session, audioToPlay);
        }
      } else if (chunk.type === 'final') {
        fullResponseText = chunk.fullText;
      } else if (chunk.type === 'transfer') {
        safeSend(session.ws, { type: 'transfer_initiated', transferTo: chunk.transferTo, reason: chunk.reason });
      } else if (chunk.type === 'transfer_agent') {
        console.log(`[🔄 Multi-Agent Squad] Transferring session ${session.id} to agent ${chunk.agentId} (${chunk.reason})`);
        safeSend(session.ws, { type: 'transfer_initiated', transferToAgent: chunk.agentId, reason: chunk.reason });
        
        const newAgent = await Agent.findById(chunk.agentId);
        if (newAgent) {
          const transferMsg = `I will transfer you to ${newAgent.name}. Please hold.`;
          safeSend(session.ws, { type: 'response_text', text: transferMsg });
          
          try {
            const ttsService = require('../services/ttsService');
            const audioBuffer = await ttsService.textToSpeech({
              text: transferMsg,
              voiceId: session.agent.voice?.voiceId || 'en-US-JennyNeural',
              provider: session.agent.voice?.provider || 'edge-tts',
            });
            if (audioBuffer && audioBuffer.length > 0) sendAudioBuffer(session, audioBuffer);
          } catch (e) {}

          // Swap agent
          session.agent = newAgent;
          session.history.push({ role: 'system', content: `[SYSTEM: Call transferred to you. Reason: ${chunk.reason}]` });
          
          // Trigger new greeting after a short delay
          setTimeout(async () => {
            const { text, audioBuffer } = await voicePipeline.getFirstMessageAudio(session.agent);
            session.history.push({ role: 'assistant', content: text, timestamp: new Date() });
            safeSend(session.ws, { type: 'response_text', text, isFirstMessage: true });
            if (audioBuffer && audioBuffer.length > 0) sendAudioBuffer(session, audioBuffer);
          }, 3000);
        } else {
          safeSend(session.ws, { type: 'error', message: 'Destination agent not found.' });
        }
      } else if (chunk.type === 'end_call') {
        setTimeout(() => handleEndSession(session, 'flow_ended'), 2000);
      }
    }
    
    fullResponseText = fullResponseText.trim();

    // Add AI response to history
    session.history.push({ role: 'assistant', content: fullResponseText, timestamp: new Date() });

    // Update call log
    queueCallLogUpdate(session, {
      $push: { transcript: { role: 'assistant', content: fullResponseText } }
    }, 'assistant_transcript');

    // Send final response text for UI consistency
    safeSend(session.ws, {
      type: 'response_text',
      text: fullResponseText,
    });

    session.status = 'listening';
    safeSend(session.ws, { type: 'status', message: '🎙️ Listening...' });

  } catch (error) {
    console.error('Pipeline error:', error);
    safeSend(session.ws, { type: 'error', message: 'AI processing failed: ' + error.message });
  } finally {
    session.isProcessing = false;
  }
}

async function handleEndSession(session, reason = 'user_hangup') {
  if (session.status === 'ended') return;
  session.status = 'ended';

  // Send goodbye if not already
  if (reason === 'user_hangup' && session.agent) {
    const endMsg = session.agent.endCallMessage || 'Goodbye! Have a great day!';
    safeSend(session.ws, { type: 'response_text', text: endMsg, isEndMessage: true });
    try {
      const { audioBuffer } = await voicePipeline.getFirstMessageAudio({
        ...session.agent.toObject(),
        firstMessage: endMsg,
      });
      if (audioBuffer && audioBuffer.length > 0) {
        sendAudioBuffer(session, audioBuffer);
      }
    } catch (e) {}
  }

  // Update call log
  const endTime = new Date();
  const duration = Math.round((endTime - new Date(session.startTime)) / 1000);

  if (session.callLogId) {
    await flushCallLogWriteQueue(session);
    const finalCallLog = await CallLog.findByIdAndUpdate(session.callLogId, {
      status: 'completed',
      endTime,
      duration,
      endReason: reason,
    }, { new: true });

    // Background analysis
    if (!session.skipPostCallAnalysis && finalCallLog && finalCallLog.transcript.length > 0) {
      voicePipeline.analyzeCall(finalCallLog.transcript).then(async (analysis) => {
        if (analysis) {
          // Save enhanced analysis fields
          await CallLog.findByIdAndUpdate(session.callLogId, {
            summary: analysis.summary,
            sentiment: analysis.sentiment,
            emotion: analysis.emotion,
            metrics: analysis.metrics,
            actionItems: analysis.actionItems,
            extractedData: analysis.extractedData,
            // New enhanced fields
            topics: analysis.topics || [],
            decisions: analysis.decisions || [],
            customerIntent: analysis.customerIntent || '',
            urgencyLevel: analysis.urgencyLevel || '',
            followUpRequired: analysis.followUpRequired || false,
            qa: { score: analysis.qaScore || 0 }
          });

          // Save to User Memory (Pichli baatein)
          if (analysis.extractedData && Object.keys(analysis.extractedData).length > 0) {
            const UserMemory = require('../models/UserMemory');
            const userPhone = session.callParams?.from || 'test_user';
            
            const newFacts = Object.entries(analysis.extractedData).map(([key, value]) => ({
              content: `${key}: ${value}`,
              category: 'extracted',
            }));
            if (newFacts.length > 0) {
              await UserMemory.findOneAndUpdate(
                { userId: session.userId, phone: userPhone },
                {
                  $push: {
                    facts: {
                      $each: newFacts,
                      $slice: -20,
                    },
                  },
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
              );
            }
            console.log(`[Memory Updated] User: ${userPhone}`);
          }

          // 📋 AUTO-CREATE CRM LEAD from extracted data
          // If the call extracted a name + phone, automatically create a lead in CRM
          try {
            const ed = analysis.extractedData || {};
            const leadName = ed.name || '';
            const leadPhone = ed.phone || '';

            if (leadName && leadPhone) {
              const Lead = require('../models/Lead');

              // Avoid duplicates: check if a lead with same phone already exists for this user
              const existingLead = await Lead.findOne({ userId: session.userId, phone: leadPhone });

              if (!existingLead) {
                await Lead.create({
                  userId: session.userId,
                  agentId: session.agent?._id,
                  callLogId: session.callLogId,
                  name: leadName,
                  phone: leadPhone,
                  email: ed.email || '',
                  interest: analysis.customerIntent || ed.company || '',
                  status: 'Warm',
                  value: '',
                  notes: analysis.summary || '',
                });
                console.log(`[CRM] Lead auto-created: ${leadName} (${leadPhone})`);
              } else {
                // Update existing lead notes with latest call summary
                await Lead.findByIdAndUpdate(existingLead._id, {
                  $set: {
                    notes: analysis.summary || existingLead.notes,
                    ...(ed.email && { email: ed.email }),
                    ...(ed.company && { interest: ed.company }),
                  },
                });
                console.log(`[CRM] Lead updated: ${leadName} (${leadPhone})`);
              }
            }
          } catch (leadErr) {
            console.error('[CRM] Auto lead creation error:', leadErr.message);
          }

          console.log(`[Analysis Complete] Session: ${session.id}`);

          // 🔗 POST-CALL WEBHOOK (n8n / Zapier / Custom Backend)
          // Fire after analysis so payload includes summary, sentiment, extractedData
          try {
            const freshCallLog = await CallLog.findById(session.callLogId);
            if (freshCallLog) {
              webhookDispatcher.dispatch(freshCallLog, session.agent, session.userSettings)
                .catch(e => console.error('[Webhook Dispatch Error]', e.message));
            }
          } catch (e) {
            console.error('[Webhook] Failed to load call log for dispatch:', e.message);
          }

          // 📱 POST-CALL NOTIFICATIONS (SMS/WhatsApp)
          // Trigger after analysis so we have summary data
          if (session.agent?.postCallActions?.sendSMS || session.agent?.postCallActions?.sendWhatsApp) {
            const updatedCallLog = await CallLog.findById(session.callLogId);
            if (updatedCallLog) {
              notificationService.sendPostCallNotifications({
                callLog: updatedCallLog,
                agent: session.agent,
                userSettings: session.userSettings,
              }).then(results => {
                if (results && results.length > 0) {
                  console.log(`[Notifications] Sent ${results.length} post-call notifications`);
                }
              }).catch(err => console.error('Post-call notification error:', err.message));
            }
          }
        }
      }).catch(err => console.error('Background analysis error:', err));
    }

    // Update agent stats
    if (session.agent) {
      await Agent.findByIdAndUpdate(session.agent._id, {
        $inc: { callsCount: 1, totalMinutes: Math.round(duration / 60) }
      });
    }
  }

  safeSend(session.ws, {
    type: 'session_ended',
    reason,
    duration,
    messageCount: session.history.length,
    callLogId: session.callLogId,
  });
}

async function cleanupSession(session) {
  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (e) {}
  }
  if (session.status !== 'ended') {
    await handleEndSession(session, 'connection_closed').catch(() => {});
  }
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(JSON.stringify(data));
    }
  } catch (e) {
    // Ignore send errors on closed connections
  }
}

function sendAudioBuffer(session, buffer) {
  // Save for full call recording (Retell style)
  if (session.fullAudioBuffer) {
    session.fullAudioBuffer.push(buffer);
  }

  // Mark agent as speaking — mutes STT processing to prevent echo loop
  // (mic picking up TTS audio → Deepgram transcribes it → agent responds to itself)
  session.agentSpeaking = true;

  const maxBufferedBytes = Number(process.env.WS_MAX_BUFFERED_BYTES || 2 * 1024 * 1024);
  if (session.ws.bufferedAmount > maxBufferedBytes) {
    const now = Date.now();
    if (now - session.warnedBackpressureAt > 3000) {
      session.warnedBackpressureAt = now;
      safeSend(session.ws, {
        type: 'status',
        message: 'Network slow: optimizing response delivery...',
      });
    }
    return;
  }

  if (session.prefersBinaryAudio) {
    safeSendBinary(session.ws, buffer);
  } else {
    // Backward-compatible JSON/base64 audio for existing clients
    safeSend(session.ws, {
      type: 'audio',
      data: buffer.toString('base64'),
    });
  }

  if (!session.latency.firstAudioAt) {
    session.latency.firstAudioAt = Date.now();
    emitLatencyMetrics(session, 'first_audio');
  }
  
  safeSend(session.ws, { type: 'audio_end' });

  // After audio_end, give 500ms for TTS to finish playing on frontend
  // before allowing STT to process again (accounts for network + playback delay)
  if (session._agentSpeakingTimer) clearTimeout(session._agentSpeakingTimer);
  session._agentSpeakingTimer = setTimeout(() => {
    session.agentSpeaking = false;
    session._lastSttTranscript = ''; // Clear any echo that accumulated during TTS
  }, 1500);
}


function safeSendBinary(ws, buffer) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(buffer, { binary: true });
    }
  } catch (e) {
    // Ignore send errors on closed connections
  }
}

function emitLatencyMetrics(session, stage = 'update') {
  const now = Date.now();
  const turnStartedAt = session.latency?.turnStartedAt;
  const llmStartedAt = session.latency?.llmStartedAt;
  const firstTextChunkAt = session.latency?.firstTextChunkAt;
  const firstAudioAt = session.latency?.firstAudioAt;

  if (!turnStartedAt) return;

  safeSend(session.ws, {
    type: 'latency_metrics',
    stage,
    traceId: session.traceId,
    turnId: session.currentGenerationId,
    timestamp: now,
    metrics: {
      stt_to_pipeline_ms: llmStartedAt ? Math.max(0, llmStartedAt - turnStartedAt) : null,
      stt_to_first_text_ms: firstTextChunkAt ? Math.max(0, firstTextChunkAt - turnStartedAt) : null,
      stt_to_first_audio_ms: firstAudioAt ? Math.max(0, firstAudioAt - turnStartedAt) : null,
      ws_buffered_amount: session.ws?.bufferedAmount || 0,
      dropped_audio_chunks: session.droppedAudioChunks || 0,
      transport: session.prefersBinaryAudio ? 'binary' : 'base64',
    },
  });
}

function queueCallLogUpdate(session, update, label = 'call_log_update') {
  if (!session?.callLogId) return;

  session.callLogWriteQueue = session.callLogWriteQueue
    .then(() => CallLog.findByIdAndUpdate(session.callLogId, update))
    .catch((err) => {
      console.error(`[CallLog Queue Error] ${label}:`, err.message);
    });
}

async function flushCallLogWriteQueue(session) {
  if (!session?.callLogWriteQueue) return;

  const timeoutMs = Number(process.env.CALL_LOG_FLUSH_TIMEOUT_MS || 1500);
  await Promise.race([
    session.callLogWriteQueue,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]).catch(() => {});
}

function allowAudioIngress(session, chunkBytes) {
  const maxChunkBytes = Number(process.env.MAX_AUDIO_CHUNK_BYTES || 256 * 1024);
  const maxBytesPerSecond = Number(process.env.MAX_AUDIO_BYTES_PER_SECOND || 512 * 1024);
  const now = Date.now();

  if (chunkBytes > maxChunkBytes) {
    session.droppedAudioChunks += 1;
    return false;
  }

  if (now - session.audioIngressWindowStartedAt >= 1000) {
    session.audioIngressWindowStartedAt = now;
    session.audioIngressBytesInWindow = 0;
  }

  if (session.audioIngressBytesInWindow + chunkBytes > maxBytesPerSecond) {
    session.droppedAudioChunks += 1;
    if (session.droppedAudioChunks % 20 === 1) {
      safeSend(session.ws, {
        type: 'status',
        message: 'Audio rate limited briefly to keep call stable.',
      });
    }
    return false;
  }

  session.audioIngressBytesInWindow += chunkBytes;
  return true;
}

function trySttFallbackReconnect(session, deepgramKey) {
  if (!session?.agent || !session?.ws) return;
  if (session.sttRetryAttempted) return;

  const fallbackLanguage = process.env.STT_FALLBACK_LANGUAGE || 'multi';
  const currentLanguage = session.agent.language || 'en';
  
  // Always allow fallback if current language is problematic
  if (currentLanguage === fallbackLanguage && currentLanguage !== 'hi') return;

  session.sttRetryAttempted = true;
  session.sttUnavailable = false;

  try {
    if (session.deepgramConn) {
      try { session.deepgramConn.finish(); } catch (_) {}
    }
  } catch (_) {}

  console.log(`[STT Fallback] Retrying with language: ${fallbackLanguage} (was: ${currentLanguage})`);
  
  safeSend(session.ws, {
    type: 'status',
    message: `🔄 Retrying STT with fallback language (${fallbackLanguage}) for better compatibility...`,
  });

  session.deepgramConn = deepgramService.createLiveConnection({
    apiKey: deepgramKey,
    language: fallbackLanguage,
    backgroundDenoising: session.agent.advanced?.backgroundDenoising || 'default',
    onTranscript: async ({ transcript, isFinal, speechFinal }) => {
      safeSend(session.ws, {
        type: 'transcript',
        text: transcript,
        isFinal: false,
        role: 'user',
      });

      const sensitivity = session.agent.advanced?.interruptionSensitivity ?? 0.5;
      const interruptThreshold = Math.max(1, Math.round(15 * (1 - sensitivity)));
      if (transcript.length >= interruptThreshold) {
        safeSend(session.ws, { type: 'interrupt' });
      }

      if (isFinal && speechFinal && transcript.trim().length > 0) {
        if (session.isProcessing) return;
        session.isProcessing = true;
        session.latency.turnStartedAt = Date.now();
        session.latency.llmStartedAt = null;
        session.latency.firstTextChunkAt = null;
        session.latency.firstAudioAt = null;
        try {
          await processTranscript(session, transcript);
        } catch (e) {
          console.error('Error processing fallback live transcript:', e);
          session.isProcessing = false;
        }
      }
    },
    onError: (err) => {
      session.sttUnavailable = true;
      safeSend(session.ws, {
        type: 'error',
        message: `Fallback STT Error: ${err?.message || 'unavailable'}`,
      });
    },
  });
}

module.exports = { setupVoiceSession };
