/**
 * VaaniAI Backend Server (FINAL STABLE - FIXED WS)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');

const connectDB = require('./config/db');
const { errorHandler } = require('./middleware/errorHandlerEnhanced');

// Routes
const authRoutes = require('./routes/auth');
const agentRoutes = require('./routes/agents');
const numberRoutes = require('./routes/numbers');
const callRoutes = require('./routes/calls');
const analyticsRoutes = require('./routes/analytics');
const settingsRoutes = require('./routes/settings');
const webhookRoutes = require('./routes/webhooks');
const twilioRoutes = require('./routes/twilio');
const voicePreviewRoutes = require('./routes/voicePreview');
const campaignRoutes = require('./routes/campaigns');
const storageRoutes = require('./routes/storage');
const superAdminRoutes = require('./routes/superAdmin');
const crmRoutes = require('./routes/crm');
const widgetRoutes = require('./routes/widget');

// WebSocket
const { setupVoiceSession } = require('./websocket/voiceSession');
const { createWebRTCServer } = require('./websocket/webrtcSession');

// Worker
const campaignWorker = require('./services/campaignWorker');

// ─── App Setup ─────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── WebSocket Setup (FINAL FIX) ───────────────────────
const wss = new WebSocket.Server({
  noServer: true, // IMPORTANT
});

setupVoiceSession(wss);

// Optional WebRTC server
createWebRTCServer(server);
  noServer: true,
  path: '/ws/voice',
});

// Wire up the voice session handler — this registers the 'connection' event
setupVoiceSession(wss);

// ─── WebRTC Session ─────────────────────────────────────────────────────────
const webrtcWss = createWebRTCServer(server);

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  try {
    const url = request.url.split('?')[0]; // ✅ handle query params

    console.log('🔌 WS Upgrade Request:', request.url);
  // Support both '/ws/voice' (frontend) and legacy '/voice' paths
  if (request.url === '/ws/voice' || request.url === '/voice') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else if (request.url === '/webrtc') {
    // WebRTC upgrade is handled by createWebRTCServer
    return;
  }
});


// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

    if (url === '/ws/voice') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('🔥 Voice WS Connected');

        wss.emit('connection', ws, request);
      });
    } else if (url === '/webrtc') {
      return;
    } else {
      console.log('❌ Unknown WS route:', url);
      socket.destroy();
    }
  } catch (err) {
    console.error('WS Upgrade Error:', err.message);
    socket.destroy();
  }
});

// ─── Debug Logger ──────────────────────────────────────
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.url}`);
  next();
});

// ─── Security ──────────────────────────────────────────
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
  })
);

// ─── CORS ──────────────────────────────────────────────
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

// ─── Static Files ──────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Body Parser ───────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Logger ────────────────────────────────────────────
app.use(morgan('dev'));

// ─── Request ID Middleware ─────────────────────────────
app.use((req, res, next) => {
  const requestId =
    req.headers['x-request-id'] || crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  next();
// ─── Health Check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🎙️ VaaniAI Backend is running!',
    version: '1.0.0',
    endpoints: {
      auth: '/api/auth',
      agents: '/api/agents',
      numbers: '/api/numbers',
      calls: '/api/calls',
      analytics: '/api/analytics',
      settings: '/api/settings',
      webhooks: '/api/webhooks',
      twilio: '/api/twilio',
      voicePreview: '/api/voice-preview',
      voices: '/api/voices',
      models: '/api/models',
      websocket: 'ws://localhost:' + (process.env.PORT || 5000) + '/ws/voice',  // matches frontend WS_BASE
    },
  });
});

// ─── Health Check ──────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongodb:
      mongoose.connection.readyState === 1
        ? 'connected'
        : 'disconnected',
    uptime: process.uptime(),
  });
});

// ─── API Routes ────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/calls', callRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/twilio', twilioRoutes);
app.use('/api/voice-preview', voicePreviewRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/recordings', storageRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/widget', widgetRoutes);

// ─── Root Route ────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🎙️ VaaniAI Backend is running!',
  });
});

// ─── 404 Handler ───────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// ─── Error Handler ─────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ──────────────────────────────────────
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    server.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
      campaignWorker.start();
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();
