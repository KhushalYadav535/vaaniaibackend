/**
 * Redis Service Wrapper
 * Handles session storage, caching, and pub/sub.
 * Falls back gracefully if Redis is not available.
 */
const Redis = require('ioredis');

class RedisService {
  constructor() {
    this.client = null;
    this.connected = false;
    this.fallbackCache = new Map(); // In-memory fallback
    this.connect();
  }

  async connect() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.client = new Redis(redisUrl, {
        retryDelayOnFailover: 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      });

      this.client.on('connect', () => {
        console.log('[Redis] Connected');
        this.connected = true;
      });

      let errorCount = 0;
      this.client.on('error', (err) => {
        if (errorCount === 0 || errorCount % 100 === 0) {
           // Only log occasionally to avoid console spam
           console.error('[Redis] Connection error:', err.message);
        }
        errorCount++;
        this.connected = false;
      });

      await this.client.connect();
    } catch (err) {
      console.warn('[Redis] Failed to connect, using memory fallback:', err.message);
      this.connected = false;
    }
  }

  isConnected() {
    return this.connected && this.client?.status === 'ready';
  }

  // Session operations
  async setSession(sessionId, data, ttlSeconds = 3600) {
    if (!sessionId || !data) return false;

    try {
      if (this.isConnected()) {
        await this.client.setex(`session:${sessionId}`, ttlSeconds, JSON.stringify(data));
        return true;
      }
      // Fallback to memory
      this.fallbackCache.set(`session:${sessionId}`, { data, expires: Date.now() + ttlSeconds * 1000 });
      return true;
    } catch (err) {
      console.error('[Redis] setSession failed:', err.message);
      return false;
    }
  }

  async getSession(sessionId) {
    if (!sessionId) return null;

    try {
      if (this.isConnected()) {
        const value = await this.client.get(`session:${sessionId}`);
        return value ? JSON.parse(value) : null;
      }
      // Fallback to memory
      const cached = this.fallbackCache.get(`session:${sessionId}`);
      if (cached && cached.expires > Date.now()) {
        return cached.data;
      }
      this.fallbackCache.delete(`session:${sessionId}`);
      return null;
    } catch (err) {
      console.error('[Redis] getSession failed:', err.message);
      return null;
    }
  }

  async deleteSession(sessionId) {
    if (!sessionId) return false;

    try {
      if (this.isConnected()) {
        await this.client.del(`session:${sessionId}`);
      }
      this.fallbackCache.delete(`session:${sessionId}`);
      return true;
    } catch (err) {
      console.error('[Redis] deleteSession failed:', err.message);
      return false;
    }
  }

  // Generic cache operations
  async set(key, value, ttlSeconds = 300) {
    try {
      if (this.isConnected()) {
        if (ttlSeconds > 0) {
          await this.client.setex(key, ttlSeconds, JSON.stringify(value));
        } else {
          await this.client.set(key, JSON.stringify(value));
        }
      } else {
        this.fallbackCache.set(key, { data: value, expires: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : 0 });
      }
      return true;
    } catch (err) {
      console.error('[Redis] set failed:', err.message);
      return false;
    }
  }

  async get(key) {
    try {
      if (this.isConnected()) {
        const value = await this.client.get(key);
        return value ? JSON.parse(value) : null;
      }
      const cached = this.fallbackCache.get(key);
      if (cached && (cached.expires === 0 || cached.expires > Date.now())) {
        return cached.data;
      }
      this.fallbackCache.delete(key);
      return null;
    } catch (err) {
      console.error('[Redis] get failed:', err.message);
      return null;
    }
  }

  async del(key) {
    try {
      if (this.isConnected()) {
        await this.client.del(key);
      }
      this.fallbackCache.delete(key);
      return true;
    } catch (err) {
      console.error('[Redis] del failed:', err.message);
      return false;
    }
  }

  // Increment operations (for rate limiting)
  async incr(key, ttlSeconds = 60) {
    try {
      if (this.isConnected()) {
        const pipeline = this.client.pipeline();
        pipeline.incr(key);
        if (ttlSeconds > 0) pipeline.expire(key, ttlSeconds);
        const results = await pipeline.exec();
        return results[0][1]; // Return incremented value
      }
      // Fallback
      const current = this.fallbackCache.get(key)?.data || 0;
      const newValue = current + 1;
      this.fallbackCache.set(key, { data: newValue, expires: Date.now() + ttlSeconds * 1000 });
      return newValue;
    } catch (err) {
      console.error('[Redis] incr failed:', err.message);
      return 0;
    }
  }

  // Health check
  async ping() {
    try {
      if (this.isConnected()) {
        const result = await this.client.ping();
        return result === 'PONG';
      }
      return false;
    } catch {
      return false;
    }
  }

  // Stats
  async getInfo() {
    try {
      if (this.isConnected()) {
        const info = await this.client.info('memory');
        const memoryMatch = info.match(/used_memory:(\d+)/);
        const usedMemory = memoryMatch ? parseInt(memoryMatch[1]) : 0;
        return {
          connected: true,
          usedMemoryBytes: usedMemory,
          fallbackCacheSize: this.fallbackCache.size,
        };
      }
      return {
        connected: false,
        usedMemoryBytes: 0,
        fallbackCacheSize: this.fallbackCache.size,
      };
    } catch (err) {
      return {
        connected: false,
        error: err.message,
        fallbackCacheSize: this.fallbackCache.size,
      };
    }
  }

  // Cleanup expired fallback entries
  cleanupFallbackCache() {
    const now = Date.now();
    for (const [key, value] of this.fallbackCache.entries()) {
      if (value.expires > 0 && value.expires <= now) {
        this.fallbackCache.delete(key);
      }
    }
  }
}

// Create singleton
const redisService = new RedisService();

// Periodic cleanup of fallback cache
setInterval(() => redisService.cleanupFallbackCache(), 60000); // Every minute

module.exports = redisService;
