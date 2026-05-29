/**
 * VaaniAI Backend Server
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
const logger = require('./utils/logger');
const { errorHandler } = require('./middleware/errorHandlerEnhanced');
const { globalLimiter, authLimiter } = require('./middleware/rateLimiter');

// ─── Routes ────────────────────────────────────────────────────────────────
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
const knowledgeBaseRoutes = require('./routes/knowledgeBase');
const callFlowsRoutes = require('./routes/callFlows');

// ─── WebSocket Handlers ─────────────────────────────────────────────────────
const { setupVoiceSession, canAcceptNewSession, getActiveSessionCount } = require('./websocket/voiceSession');
const { createWebRTCServer } = require('./websocket/webrtcSession');

// ─── Worker ─────────────────────────────────────────────────────────────────
const campaignWorker = require('./services/campaignWorker');

// ─── App & HTTP Server ──────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── WebSocket Setup ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true });

// Register the voice session connection handler
setupVoiceSession(wss);

// WebRTC: currently a stub (mock SDP, no real RTCPeerConnection on Node).
// Proper implementation needs `wrtc` (heavy native build) or `mediasoup`.
// Until that lands, the /ws/voice WebSocket pipeline is the supported path.
// Toggle via WEBRTC_EXPERIMENTAL=true if you want to opt in for development.
if (String(process.env.WEBRTC_EXPERIMENTAL || 'false').toLowerCase() === 'true') {
  console.warn('⚠️  WEBRTC_EXPERIMENTAL=true — registering /webrtc stub. NOT production-ready.');
  createWebRTCServer(server);
}

// Route WebSocket upgrade requests
server.on('upgrade', (request, socket, head) => {
  try {
    const url = request.url.split('?')[0]; // strip query params

    console.log('🔌 WS Upgrade Request:', url);

    if (url === '/ws/voice' || url === '/voice') {
      // Concurrency cap — reject politely if we're at max sessions.
      // 1013 = "Try Again Later" per RFC 6455.
      if (!canAcceptNewSession()) {
        console.warn(`⚠️  WS upgrade rejected — concurrency cap reached (${getActiveSessionCount()})`);
        socket.write(
          'HTTP/1.1 503 Service Unavailable\r\n' +
          'Content-Type: application/json\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          JSON.stringify({ error: 'server_busy', message: 'Too many concurrent voice sessions. Please try again in a moment.' })
        );
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        console.log('🔥 Voice WS Connected');
        wss.emit('connection', ws, request);
      });
    } else if (url === '/webrtc') {
      // Handled by createWebRTCServer when WEBRTC_EXPERIMENTAL=true.
      // Otherwise reject explicitly so clients don't hang on a half-open socket.
      if (String(process.env.WEBRTC_EXPERIMENTAL || 'false').toLowerCase() !== 'true') {
        socket.write(
          'HTTP/1.1 501 Not Implemented\r\n' +
          'Content-Type: application/json\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          JSON.stringify({ error: 'webrtc_disabled', message: 'WebRTC endpoint is disabled. Use /ws/voice.' })
        );
        socket.destroy();
        return;
      }
      // When experimental is on, createWebRTCServer registered its own upgrade handler.
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

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allowed origins come from ALLOWED_ORIGINS (comma-separated).
      // Requests with no Origin header (mobile apps, curl, server-to-server,
      // same-origin) are allowed. Browser cross-origin requests must match.
      const allowed = (process.env.ALLOWED_ORIGINS || process.env.CORS_ALLOWED_ORIGINS || '')
        .split(',')
        .map(o => o.trim())
        .filter(Boolean);

      if (!origin) return callback(null, true);
      if (allowed.length === 0) {
        // No allowlist configured — permissive in dev, warn loudly so it
        // gets locked down before production.
        if (String(process.env.NODE_ENV) === 'production') {
          logger.warn('ALLOWED_ORIGINS not set in production — rejecting cross-origin request', { origin });
          return callback(new Error('Not allowed by CORS'));
        }
        return callback(null, true);
      }
      if (allowed.includes(origin)) return callback(null, true);
      logger.warn('Blocked CORS origin', { origin });
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// HTTP access logging via winston (single source of truth — no more
// duplicate morgan('dev') + console.log per request).
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: logger.stream }));

// ─── Request ID ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

// ─── Global Rate Limiter ──────────────────────────────────────────────────────
// Protects every API route from abuse/brute-force. /health is skipped inside
// the limiter config. Auth routes get a stricter limiter wired below.
app.use('/api', globalLimiter);

// ─── Health Checks ──────────────────────────────────────────────────────────
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
      websocket: 'ws://localhost:' + (process.env.PORT || 5000) + '/ws/voice',
    },
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    uptime: process.uptime(),
  });
});

// ─── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRoutes);
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
app.use('/api/knowledge-base', knowledgeBaseRoutes);
app.use('/api/call-flows', callFlowsRoutes);

// ─── 404 Handler ────────────────────────────────────────────────────────────
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`,
  });
});

// ─── Error Handler ───────────────────────────────────────────────────────────
app.use(errorHandler);

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

// When running under PM2 cluster mode, the campaign worker must run in EXACTLY
// one process — otherwise every worker polls and dispatches the same campaigns,
// causing duplicate calls. ecosystem.config.js runs a dedicated fork with
// CAMPAIGN_WORKER_ONLY=true for this. In single-process/dev mode (no flag and
// not clustered) we still start it inline.
const isClustered = !!process.env.NODE_APP_INSTANCE || !!process.env.pm_id;
const campaignWorkerOnly = String(process.env.CAMPAIGN_WORKER_ONLY || '').toLowerCase() === 'true';
const shouldRunCampaignWorker = campaignWorkerOnly || !isClustered;

const startServer = async () => {
  try {
    await connectDB();

    server.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
      if (shouldRunCampaignWorker) {
        logger.info('Starting campaign worker in this process');
        campaignWorker.start();
      } else {
        logger.info('Campaign worker NOT started here (clustered worker handled by dedicated process)');
      }
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
};

// ─── Process-level safety nets ────────────────────────────────────────────────
// Without these an unhandled rejection (e.g. a background analysis chain that
// throws) can crash the whole process and drop every live call.
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason?.message || String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err?.message, stack: err?.stack });
});

startServer();
