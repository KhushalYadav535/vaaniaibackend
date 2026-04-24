/**
 * Advanced Rate Limiting Middleware
 * Prevents abuse and ensures fair usage across the platform
 */
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis');
const redis = require('redis');

// Initialize Redis client (optional - falls back to memory)
let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = redis.createClient({ url: process.env.REDIS_URL });
  redisClient.connect().catch(err => console.warn('⚠️ Redis connection failed:', err.message));
}

// ─── GLOBAL RATE LIMITERS ───────────────────────────────────────────────

/**
 * Global API limiter - 100 requests per 15 minutes
 */
const globalLimiter = rateLimit({
  ...(redisClient ? {
    store: new RedisStore({
      client: redisClient,
      prefix: 'rl:global:',
    }),
  } : {}),
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/health';
  },
});

/**
 * Auth endpoint limiter - 5 attempts per 15 minutes
 */
const authLimiter = rateLimit({
  ...(redisClient ? {
    store: new RedisStore({
      client: redisClient,
      prefix: 'rl:auth:',
    }),
  } : {}),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later.' },
  skipSuccessfulRequests: true, // Don't count successful logins
});

/**
 * API Key rate limiter - user-based limiting
 */
const createUserLimiter = (options = {}) => {
  const {
    windowMs = 60 * 60 * 1000, // 1 hour
    max = 1000,
    message = 'API rate limit exceeded',
  } = options;

  return rateLimit({
    ...(redisClient ? {
      store: new RedisStore({
        client: redisClient,
        prefix: 'rl:user:',
      }),
    } : {}),
    windowMs,
    max,
    keyGenerator: (req) => {
      // Use user ID if authenticated, otherwise use IP
      return req.user?._id?.toString() || req.ip;
    },
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
  });
};

/**
 * Voice call limiter - prevent abuse of calling features
 * 50 outbound calls per hour per user
 */
const voiceCallLimiter = createUserLimiter({
  windowMs: 60 * 60 * 1000,
  max: 50,
  message: 'Call limit exceeded. Maximum 50 calls per hour.',
});

/**
 * Campaign limiter - 5 campaigns per hour
 */
const campaignLimiter = createUserLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Campaign creation limit exceeded.',
});

/**
 * WebSocket connection limiter
 * Track active connections per user
 */
class WebSocketRateLimiter {
  constructor(maxConnectionsPerUser = 5) {
    this.maxConnections = maxConnectionsPerUser;
    this.connections = new Map(); // userId -> Set of connectionIds
  }

  canConnect(userId) {
    const userConnections = this.connections.get(userId.toString()) || new Set();
    return userConnections.size < this.maxConnections;
  }

  addConnection(userId, connectionId) {
    const key = userId.toString();
    if (!this.connections.has(key)) {
      this.connections.set(key, new Set());
    }
    this.connections.get(key).add(connectionId);
  }

  removeConnection(userId, connectionId) {
    const key = userId.toString();
    const userConnections = this.connections.get(key);
    if (userConnections) {
      userConnections.delete(connectionId);
      if (userConnections.size === 0) {
        this.connections.delete(key);
      }
    }
  }

  getConnectionCount(userId) {
    return (this.connections.get(userId.toString()) || new Set()).size;
  }
}

const wsRateLimiter = new WebSocketRateLimiter(5);

// ─── CUSTOM LIMITERS ────────────────────────────────────────────────────

/**
 * Create a burst limiter for temporary spikes
 * Allows higher throughput in short bursts
 */
const createBurstLimiter = (burstSize = 10, window = 60000) => {
  return rateLimit({
    windowMs: window,
    max: burstSize,
    message: { error: 'Request burst limit exceeded' },
    standardHeaders: true,
    skipFailedRequests: true,
  });
};

/**
 * Create sliding window counter for precise rate limiting
 */
class SlidingWindowLimiter {
  constructor(maxRequests, windowMs) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.requests = new Map(); // key -> array of timestamps
  }

  isLimited(key) {
    const now = Date.now();
    const userRequests = this.requests.get(key) || [];

    // Remove expired requests
    const activeRequests = userRequests.filter(
      timestamp => now - timestamp < this.windowMs
    );

    if (activeRequests.length >= this.maxRequests) {
      return true; // Limited
    }

    // Add current request
    activeRequests.push(now);
    this.requests.set(key, activeRequests);
    return false;
  }

  getRemainingRequests(key) {
    const now = Date.now();
    const userRequests = this.requests.get(key) || [];
    const activeRequests = userRequests.filter(
      timestamp => now - timestamp < this.windowMs
    );
    return Math.max(0, this.maxRequests - activeRequests.length);
  }
}

const slidingWindowLimiter = new SlidingWindowLimiter(1000, 60 * 60 * 1000); // 1000 per hour

// ─── MIDDLEWARE EXPORTS ─────────────────────────────────────────────────

module.exports = {
  // Limiters
  globalLimiter,
  authLimiter,
  createUserLimiter,
  voiceCallLimiter,
  campaignLimiter,
  wsRateLimiter,
  createBurstLimiter,
  slidingWindowLimiter,

  /**
   * Middleware to attach rate limit info to response
   */
  attachRateLimitInfo: (req, res, next) => {
    const remaining = slidingWindowLimiter.getRemainingRequests(
      req.user?._id?.toString() || req.ip
    );
    res.set('X-RateLimit-Remaining', remaining.toString());
    res.set('X-RateLimit-Reset', new Date(Date.now() + 60 * 60 * 1000).toISOString());
    next();
  },

  /**
   * Graceful handler when rate limit is exceeded
   */
  handleRateLimitExceeded: (req, res) => {
    const retryAfter = req.rateLimit?.resetTime
      ? Math.ceil((req.rateLimit.resetTime - Date.now()) / 1000)
      : 3600;

    res.set('Retry-After', retryAfter.toString());
    res.status(429).json({
      success: false,
      error: 'Too many requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter,
    });
  },
};
