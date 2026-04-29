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

// WebSocket
const { setupVoiceSession } = require('./websocket/voiceSession');

// Worker
const campaignWorker = require('./services/campaignWorker');

// ─── App Setup ─────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── WebSocket Setup ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws/voice' });
setupVoiceSession(wss);
console.log('🔌 WebSocket server ready on /ws/voice');

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    /\.yourdomain\.com$/,  // Add your domain here
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
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
      websocket: 'ws://localhost:' + (process.env.PORT || 5000) + '/ws/voice',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mongodb: require('mongoose').connection.readyState === 1 ? 'connected' : 'disconnected',
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

// TTS Voice list (public - no auth needed)
app.get('/api/voices', (req, res) => {
  const ttsService = require('./services/ttsService');
  res.json({ success: true, voices: ttsService.constructor.getAvailableVoices() });
});

// LLM Models list (public)
app.get('/api/models', (req, res) => {
  const groqService = require('./services/groqService');
  res.json({ success: true, models: groqService.constructor.getAvailableModels() });
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

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});
