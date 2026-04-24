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

// Track active sessions
const activeSessions = new Map();

function setupVoiceSession(wss) {
  wss.on('connection', (ws) => {
    const sessionId = uuidv4();
    let session = {
      id: sessionId,
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
    };

    activeSessions.set(sessionId, session);
    console.log(`🔌 WebSocket connected: ${sessionId}`);

    // Send ready ping
    safeSend(ws, { type: 'connected', sessionId });

    ws.on('message', async (rawData) => {
      try {
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

async function handleInit(session, message) {
  const { agentId, token } = message;

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

  // Load agent
  const agent = await Agent.findOne({ _id: agentId, userId: user._id });
  if (!agent) throw new Error('Agent not found or not authorized');

  session.userId = user._id;
  session.agent = agent;
  session.userSettings = user.settings || {};
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

  // Set up live Deepgram Connection for continuous transcription
  const deepgramKey = session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
  if (!deepgramKey) {
    throw new Error('No Deepgram API key configured. Live voice requires Deepgram.');
  }

  // Use the agent's configured language for STT (hindi = 'hi', english = 'en', multilingual = 'multi')
  const sttLanguage = agent.language || 'en';
  console.log(`🌐 Agent language: ${sttLanguage}`);

  session.deepgramConn = deepgramService.createLiveConnection({
    apiKey: deepgramKey,
    language: sttLanguage,
    backgroundDenoising: agent.advanced?.backgroundDenoising || 'default',
    onTranscript: async ({ transcript, isFinal, speechFinal }) => {
      // Send interim updates
      safeSend(session.ws, {
         type: 'transcript',
         text: transcript,
         isFinal: false,
         role: 'user',
      });

      // Interruption logic driven by agent's interruptionSensitivity (0 = hard to interrupt, 1 = easily interrupted)
      // If sensitivity is 1, interrupt immediately (threshold 1 char)
      // If sensitivity is 0, require more characters before interrupting (threshold 15 chars)
      const sensitivity = agent.advanced?.interruptionSensitivity ?? 0.5;
      const interruptThreshold = Math.max(1, Math.round(15 * (1 - sensitivity)));
      
      if (transcript.length >= interruptThreshold) {
         safeSend(session.ws, { type: 'interrupt' });
      }

      // If sentence ended, process it!
      if (isFinal && speechFinal && transcript.trim().length > 0) {
        if (session.isProcessing) return; // Prevent overlapping requests
        session.isProcessing = true;
        
        try {
          await processTranscript(session, transcript);
        } catch (e) {
          console.error("Error processing live transcript:", e);
          session.isProcessing = false;
        }
      }
    },
    onError: (err) => {
      safeSend(session.ws, { type: 'error', message: 'Deepgram Error: ' + err.message });
    }
  });

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
      await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { role: 'assistant', content: firstMessageText } }
      });

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
      await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { role: 'assistant', content: text } }
      });

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
  if (!session.agent || !session.deepgramConn) return;

  // Stream directly to deepgram
  const audioData = Buffer.from(message.data, 'base64');
  try {
    session.deepgramConn.send(audioData);
  } catch (e) {
    console.error("Failed to send chunk to deepgram:", e);
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
          apiKey: session.userSettings.ttsKey || process.env.ELEVENLABS_API_KEY
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
    if (session.callLogId) {
      await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { role: 'user', content: transcript } }
      });
    }

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
        // Send this sentence's text and audio immediately
        safeSend(session.ws, {
          type: 'response_text_chunk',
          text: chunk.text,
        });

        fullResponseText += chunk.text + ' ';

        let audioToPlay = chunk.audio;
        if (!audioToPlay && session.callFlow && chunk.text) {
           // CallFlow engine yields text chunks without TTS, so we generate TTS here
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
    if (session.callLogId) {
      await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { role: 'assistant', content: fullResponseText } }
      });
    }

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
    const finalCallLog = await CallLog.findByIdAndUpdate(session.callLogId, {
      status: 'completed',
      endTime,
      duration,
      endReason: reason,
    }, { new: true });

    // Background analysis
    if (finalCallLog && finalCallLog.transcript.length > 0) {
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
            
            let memory = await UserMemory.findOne({ userId: session.userId, phone: userPhone });
            if (!memory) {
              memory = new UserMemory({ userId: session.userId, phone: userPhone, facts: [] });
            }

            // Add new facts from extracted data
            Object.entries(analysis.extractedData).forEach(([key, value]) => {
              memory.facts.push({ content: `${key}: ${value}`, category: 'extracted' });
            });
            
            // Keep only last 20 facts
            if (memory.facts.length > 20) memory.facts = memory.facts.slice(-20);
            
            await memory.save();
            console.log(`[Memory Updated] User: ${userPhone}`);
          }
          
          console.log(`[Analysis Complete] Session: ${session.id}`);

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

  // Send the entire buffer as one base64 string to avoid padding issues with chunks
  safeSend(session.ws, {
    type: 'audio',
    data: buffer.toString('base64'),
  });
  
  safeSend(session.ws, { type: 'audio_end' });
}

module.exports = { setupVoiceSession };
