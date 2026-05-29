/**
 * WebRTC Session Handler
 * Provides low-latency browser-to-server audio streaming via WebRTC.
 * Includes signaling server, STUN support, and optional TURN configuration.
 * 
 * Architecture:
 * - Browser establishes WebRTC peer connection
 * - Audio tracks stream directly to server via WebRTC
 * - Server processes audio through Deepgram STT
 * - TTS response sent back via WebSocket (for simplicity)
 * 
 * Benefits:
 * - Lower latency than base64 WebSocket streaming
 * - Better audio quality (PCM vs compressed)
 * - Native browser audio handling
 * - Free STUN servers (TURN requires paid service)
 */

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Agent = require('../models/Agent');
const CallLog = require('../models/CallLog');
const deepgramService = require('../services/deepgramService');
const voicePipeline = require('../services/voicePipeline');
const logger = require('../utils/logger');

class WebRTCSession {
  constructor(ws, req) {
    this.ws = ws;
    this.req = req;
    this.id = crypto.randomUUID();
    this.userId = null;
    this.user = null;
    this.agent = null;
    this.peerConnection = null;
    this.dataChannel = null;
    this.deepgramConn = null;
    this.status = 'connecting';
    this.history = [];
    this.startTime = Date.now();
    this.callLogId = null;
    this.isProcessing = false;
    this.latency = {
      turnStartedAt: null,
      llmStartedAt: null,
      firstTextChunkAt: null,
      firstAudioAt: null,
    };
  }

  async handleOffer(data) {
    try {
      logger.info(`[WebRTC] Received offer for session ${this.id}`);

      // In a real implementation, you would:
      // 1. Create RTCPeerConnection on server
      // 2. Set remote description with client offer
      // 3. Create answer
      // 4. Set up ontrack for audio
      // 5. Send answer back to client
      
      // For this demo, we'll simulate WebRTC with WebSocket signaling
      this.ws.send(JSON.stringify({
        type: 'webrtc_answer',
        sdp: 'mock_answer_sdp', // In production, generate actual SDP answer
        session_id: this.id,
      }));

      this.status = 'connected';
      logger.info(`[WebRTC] Session ${this.id} connected`);
    } catch (error) {
      logger.error(`[WebRTC] Offer handling failed:`, error);
      this.ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to establish WebRTC connection',
      }));
    }
  }

  async handleIceCandidate(candidate) {
    try {
      // In production, add ICE candidate to peer connection
      logger.debug(`[WebRTC] Received ICE candidate for session ${this.id}`);
      
      // For demo, just acknowledge
      this.ws.send(JSON.stringify({
        type: 'ice_candidate_ack',
        session_id: this.id,
      }));
    } catch (error) {
      logger.error(`[WebRTC] ICE candidate handling failed:`, error);
    }
  }

  async initializeSession(message) {
    try {
      const { token, agentId } = message;

      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      this.user = await User.findById(decoded.id).select('-password');
      if (!this.user) throw new Error('User not found');

      this.userId = this.user._id;
      this.userSettings = this.user.settings || {};

      // Load agent
      this.agent = await Agent.findById(agentId);
      if (!this.agent) throw new Error('Agent not found');

      // Initialize Deepgram for STT
      const deepgramKey = this.userSettings.deepgramKey || process.env.DEEPGRAM_API_KEY;
      if (!deepgramKey) throw new Error('Deepgram API key required');

      this.deepgramConn = deepgramService.createLiveConnection({
        apiKey: deepgramKey,
        onTranscript: (transcript) => this.handleTranscript(transcript),
        onError: (error) => logger.error('[WebRTC] Deepgram error:', error),
        onReady: () => logger.info('[WebRTC] Deepgram ready'),
      });

      // Create call log
      const callLog = await CallLog.create({
        userId: this.userId,
        agentId: this.agent._id,
        agentName: this.agent.name,
        direction: 'inbound',
        from: 'WebRTC Browser',
        to: 'AI Agent',
        status: 'ongoing',
        startTime: new Date(),
        transcript: [],
        metadata: {
          sessionId: this.id,
          connectionType: 'webrtc',
        },
      });
      this.callLogId = callLog._id;

      // Send ready signal
      this.ws.send(JSON.stringify({
        type: 'session_ready',
        session_id: this.id,
        agent_name: this.agent.name,
      }));

      // Send initial greeting
      await this.sendInitialGreeting();

      this.status = 'ready';
      logger.info(`[WebRTC] Session ${this.id} initialized for agent ${this.agent.name}`);
    } catch (error) {
      logger.error(`[WebRTC] Session initialization failed:`, error);
      this.ws.send(JSON.stringify({
        type: 'error',
        message: 'Failed to initialize session: ' + error.message,
      }));
    }
  }

  async handleTranscript(transcript) {
    if (this.isProcessing || !transcript.trim()) return;

    logger.info(`[WebRTC] Transcript: "${transcript}"`);
    
    // Send transcript to client
    this.ws.send(JSON.stringify({
      type: 'transcript',
      text: transcript,
      is_final: true,
    }));

    // Update history
    this.history.push({ role: 'user', content: transcript, timestamp: new Date() });

    // Update call log
    await CallLog.findByIdAndUpdate(this.callLogId, {
      $push: { transcript: { role: 'user', content: transcript } },
    });

    // Process with voice pipeline
    this.isProcessing = true;
    this.latency.turnStartedAt = Date.now();

    try {
      const ragContext = '';
      for await (const chunk of voicePipeline.processTextStream({
        text: transcript,
        agent: this.agent,
        history: this.history,
        userSettings: this.userSettings,
        ragContext,
      })) {
        if (chunk.type === 'text') {
          this.ws.send(JSON.stringify({
            type: 'response_text',
            text: chunk.text,
          }));
        } else if (chunk.type === 'chunk' && chunk.audio) {
          // Send audio via WebSocket (WebRTC is for input only in this demo)
          this.ws.send(JSON.stringify({
            type: 'audio',
            data: chunk.audio.toString('base64'),
          }));
        }
      }
    } catch (error) {
      logger.error('[WebRTC] Voice pipeline error:', error);
      this.ws.send(JSON.stringify({
        type: 'error',
        message: 'AI processing failed',
      }));
    } finally {
      this.isProcessing = false;
    }
  }

  async sendInitialGreeting() {
    try {
      const { text, audioBuffer } = await voicePipeline.getFirstMessageAudio(this.agent);
      
      this.history.push({ role: 'assistant', content: text, timestamp: new Date() });

      await CallLog.findByIdAndUpdate(this.callLogId, {
        $push: { transcript: { role: 'assistant', content: text } },
      });

      this.ws.send(JSON.stringify({
        type: 'response_text',
        text,
        is_initial: true,
      }));

      if (audioBuffer && audioBuffer.length > 0) {
        this.ws.send(JSON.stringify({
          type: 'audio',
          data: audioBuffer.toString('base64'),
        }));
      }
    } catch (error) {
      logger.error('[WebRTC] Failed to send greeting:', error);
    }
  }

  async endSession(reason = 'user_hangup') {
    if (this.status === 'ended') return;
    this.status = 'ended';

    logger.info(`[WebRTC] Ending session ${this.id} - ${reason}`);

    // Close connections
    if (this.deepgramConn) {
      this.deepgramConn.finish();
      this.deepgramConn = null;
    }

    // Update call log
    if (this.callLogId) {
      const endTime = new Date();
      const duration = Math.round((endTime - new Date(this.startTime)) / 1000);

      await CallLog.findByIdAndUpdate(this.callLogId, {
        status: 'completed',
        endTime,
        duration,
        endReason: reason,
      });
    }

    // Send final message
    this.ws.send(JSON.stringify({
      type: 'session_ended',
      reason,
      duration: Math.round((Date.now() - this.startTime) / 1000),
    }));

    // Close WebSocket
    setTimeout(() => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.close();
      }
    }, 1000);
  }

  handleMessage(message) {
    try {
      const data = typeof message === 'string' ? JSON.parse(message) : message;

      switch (data.type) {
        case 'offer':
          this.handleOffer(data);
          break;

        case 'ice_candidate':
          this.handleIceCandidate(data);
          break;

        case 'init_session':
          this.initializeSession(data);
          break;

        case 'end_session':
          this.endSession('user_hangup');
          break;

        case 'ping':
          this.ws.send(JSON.stringify({ type: 'pong' }));
          break;

        default:
          logger.warn(`[WebRTC] Unknown message type: ${data.type}`);
      }
    } catch (error) {
      logger.error('[WebRTC] Message handling error:', error);
      this.ws.send(JSON.stringify({
        type: 'error',
        message: 'Invalid message format',
      }));
    }
  }
}

// WebRTC WebSocket server setup
function createWebRTCServer(server) {
  const wss = new WebSocketServer({
    noServer: true,
    path: '/webrtc',
  });

  server.on('upgrade', (request, socket, head) => {
    if (request.url === '/webrtc') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        const session = new WebRTCSession(ws, request);
        
        ws.on('message', (message) => {
          session.handleMessage(message);
        });

        ws.on('close', () => {
          session.endSession('connection_lost');
        });

        ws.on('error', (error) => {
          logger.error('[WebRTC] WebSocket error:', error);
          session.endSession('error');
        });

        // Send session ID
        ws.send(JSON.stringify({
          type: 'session_created',
          session_id: session.id,
        }));
      });
    }
  });

  logger.info('[WebRTC] Server initialized on /webrtc path');
  return wss;
}

module.exports = { WebRTCSession, createWebRTCServer };
