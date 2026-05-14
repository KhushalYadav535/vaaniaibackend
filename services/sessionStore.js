/**
 * Session Store Service
 * Manages WebSocket voice sessions with Redis backend for scalability.
 * Provides session persistence across server restarts and clustering.
 */
const redisService = require('./redisService');

class SessionStore {
  constructor() {
    this.localSessions = new Map(); // Fallback for when Redis is down
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000); // Cleanup every minute
  }

  /**
   * Store session data
   */
  async setSession(sessionId, data, ttlSeconds = 7200) { // 2 hours default
    if (!sessionId) return false;

    const sessionData = {
      ...data,
      lastActivity: Date.now(),
    };

    try {
      // Try Redis first
      const success = await redisService.setSession(`voice:${sessionId}`, sessionData, ttlSeconds);
      if (success) {
        // Also keep local copy for fast access
        this.localSessions.set(sessionId, sessionData);
        return true;
      }
    } catch (err) {
      console.error('[SessionStore] Redis set failed:', err.message);
    }

    // Fallback to local memory only
    this.localSessions.set(sessionId, {
      ...sessionData,
      expires: Date.now() + ttlSeconds * 1000,
    });
    return true;
  }

  /**
   * Get session data
   */
  async getSession(sessionId) {
    if (!sessionId) return null;

    try {
      // Try Redis first
      const data = await redisService.getSession(`voice:${sessionId}`);
      if (data) {
        // Update local cache
        this.localSessions.set(sessionId, data);
        return data;
      }
    } catch (err) {
      console.error('[SessionStore] Redis get failed:', err.message);
    }

    // Fallback to local memory
    const local = this.localSessions.get(sessionId);
    if (local) {
      // Check if expired
      if (local.expires && local.expires <= Date.now()) {
        this.localSessions.delete(sessionId);
        return null;
      }
      return local;
    }

    return null;
  }

  /**
   * Update specific fields in session
   */
  async updateSession(sessionId, updates) {
    if (!sessionId) return false;

    const current = await this.getSession(sessionId);
    if (!current) return false;

    const updated = {
      ...current,
      ...updates,
      lastActivity: Date.now(),
    };

    return await this.setSession(sessionId, updated);
  }

  /**
   * Delete session
   */
  async deleteSession(sessionId) {
    if (!sessionId) return false;

    try {
      await redisService.deleteSession(`voice:${sessionId}`);
    } catch (err) {
      console.error('[SessionStore] Redis delete failed:', err.message);
    }

    this.localSessions.delete(sessionId);
    return true;
  }

  /**
   * List all active sessions (for monitoring)
   */
  async listActiveSessions() {
    const sessions = [];
    
    // Add local sessions
    for (const [id, data] of this.localSessions.entries()) {
      if (!data.expires || data.expires > Date.now()) {
        sessions.push({ id, ...data, source: 'local' });
      }
    }

    // TODO: Add Redis scan if needed for monitoring multiple servers
    return sessions;
  }

  /**
   * Get session count
   */
  async getSessionCount() {
    let count = 0;
    
    // Count local sessions
    for (const [id, data] of this.localSessions.entries()) {
      if (!data.expires || data.expires > Date.now()) {
        count++;
      }
    }

    return count;
  }

  /**
   * Cleanup expired sessions
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, data] of this.localSessions.entries()) {
      if (data.expires && data.expires <= now) {
        this.localSessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SessionStore] Cleaned ${cleaned} expired local sessions`);
    }
  }

  /**
   * Store session state for recovery
   */
  async saveState(sessionId, state) {
    return await redisService.set(`state:${sessionId}`, state, 3600); // 1 hour
  }

  /**
   * Recover session state
   */
  async recoverState(sessionId) {
    return await redisService.get(`state:${sessionId}`);
  }

  /**
   * Cache frequently accessed data
   */
  async cache(key, value, ttlSeconds = 300) {
    return await redisService.set(`cache:${key}`, value, ttlSeconds);
  }

  async getCached(key) {
    return await redisService.get(`cache:${key}`);
  }

  /**
   * Rate limiting helper
   */
  async checkRateLimit(identifier, limit = 10, windowSeconds = 60) {
    const key = `rate:${identifier}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
    const count = await redisService.incr(key, windowSeconds);
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count) };
  }

  /**
   * Health check
   */
  async getHealth() {
    const redisHealth = await redisService.getInfo();
    return {
      redis: redisHealth,
      localSessions: this.localSessions.size,
      uptime: process.uptime(),
    };
  }
}

module.exports = new SessionStore();
