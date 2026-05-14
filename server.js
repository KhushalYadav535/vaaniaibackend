/**
 * VaaniAI Backend Server
 * Node.js + Express + MongoDB + WebSocket
 * 
 * Start: node server.js
 * Dev: npm run dev (with nodemon)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const connectDB = require('./config/db');
const { errorHandler, asyncHandler } = require('./middleware/errorHandlerEnhanced');
const {
  globalLimiter,
  authLimiter,
  voiceCallLimiter,
  campaignLimiter,
} = require('./middleware/rateLimiter');

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
const path = require('path');

// WebSocket
const { setupVoiceSession } = require('./websocket/voiceSession');

// WebRTC
const { createWebRTCServer } = require('./websocket/webrtcSession');

// Worker
const campaignWorker = require('./services/campaignWorker');

// ─── App Setup ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── WebSocket Voice Session ───────────────────────────────────────────────
const wss = new WebSocket.Server({
  noServer: true,
  path: '/ws/voice',
});

// Wire up the voice session handler — this registers the 'connection' event
setupVoiceSession(wss);

// ─── WebRTC Session ─────────────────────────────────────────────────────────
const webrtcWss = createWebRTCServer(server);

server.on('upgrade', (request, socket, head) => {
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

app.use(cors({
  origin: true, // Allow all origins for widget support
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Serve static files (widget.js etc.)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined'));
}

// ─── Request Correlation ID ─────────────────────────────────────────────────
app.use((req, res, next) => {
  const incomingId = req.headers['x-request-id'];
  const requestId = (typeof incomingId === 'string' && incomingId.trim()) || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

// ─── Global Rate Limiting ───────────────────────────────────────────────────
app.use('/api/', globalLimiter);

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

app.get('/health', (req, res) => {
  const ttsService = require('./services/ttsService');
  res.json({
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mongodb: require('mongoose').connection.readyState === 1 ? 'connected' : 'disconnected',
    ttsCache: ttsService.getCacheStats(),
    activeWsSessions: wss.clients ? wss.clients.size : 0,
    memoryMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
  });
});

const callFlowRoutes = require('./routes/callFlows');

// ─── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/calls', voiceCallLimiter, callRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/twilio', twilioRoutes);
app.use('/api/voice-preview', voicePreviewRoutes);
app.use('/api/campaigns', campaignLimiter, campaignRoutes);
app.use('/api/recordings', storageRoutes);
app.use('/api/call-flows', callFlowRoutes);
const knowledgeBaseRoutes = require('./routes/knowledgeBase');
app.use('/api/knowledge-base', knowledgeBaseRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/widget', widgetRoutes);
const usageRoutes = require('./routes/usage');
app.use('/api/usage', usageRoutes);

// TTS Voice list (public - no auth needed)
app.get('/api/voices', (req, res) => {
  const ttsService = require('./services/ttsService');
  res.json({ success: true, voices: ttsService.constructor.getAvailableVoices() });
});

// LLM Models list (public)
app.get('/api/models', (req, res) => {
  const groqService = require('./services/groqService');
  const geminiService = require('./services/geminiService');
  const models = [
    ...groqService.constructor.getAvailableModels(),
    ...geminiService.constructor.getAvailableModels(),
  ];
  res.json({ success: true, models });
});

// ─── 404 Handler ────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found` });
});

// ─── Error Handler ──────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.JWT_SECRET === 'vaaniai_super_secret_jwt_key_change_in_production_2024'
    ) {
      throw new Error('Refusing to start in production with default JWT_SECRET');
    }

    await connectDB().then(() => {
      server.listen(PORT, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════════╗');
        console.log('║        🎙️  VaaniAI Backend Started         ║');
        console.log('╠═══════════════════════════════════════════╣');
        console.log(`║  HTTP:  http://localhost:${PORT}`.padEnd(44) + '║');
        console.log(`║  WS:    ws://localhost:${PORT}/ws/voice`.padEnd(44) + '║');
        console.log(`║  Env:   ${process.env.NODE_ENV || 'development'}`.padEnd(44) + '║');
        console.log('╚═══════════════════════════════════════════╝');
        console.log('');
        
        // Start background workers
        campaignWorker.start();
      });
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();

// Graceful shutdown — close WS connections, flush DB, stop workers
const gracefulShutdown = (signal) => {
  console.log(`${signal} received. Shutting down gracefully...`);
  
  // 1. Stop accepting new connections
  server.close(() => {
    console.log('HTTP server closed.');
  });

  // 2. Close all active WebSocket connections
  if (wss.clients) {
    console.log(`Closing ${wss.clients.size} active WebSocket connections...`);
    wss.clients.forEach((ws) => {
      try {
        ws.close(1001, 'Server shutting down');
      } catch (e) { /* ignore */ }
    });
  }

  // 3. Stop background workers
  try { campaignWorker.stop?.(); } catch (e) { /* ignore */ }

  // 4. Close MongoDB connection
  const mongoose = require('mongoose');
  mongoose.connection.close(false).then(() => {
    console.log('MongoDB connection closed.');
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });

  // Force exit after 10 seconds if graceful shutdown hangs
  setTimeout(() => {
    console.error('Forced exit after timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
