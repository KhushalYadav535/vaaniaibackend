/**
 * Server Events Dispatcher — mid-call real-time webhooks (Vapi-style).
 *
 * Fires HMAC-signed POST requests during a live call so external systems
 * (n8n, Zapier, custom backend) can react in real time:
 *   • call.started        — when session is initialised
 *   • transcript.segment  — every user utterance + agent response
 *   • sentiment.shift     — when sentiment changes from prev value
 *   • tool.called         — when an LLM tool fires
 *   • transferred         — squad handoff or human transfer
 *   • call.ended          — wrap-up (post-analysis fields included)
 *
 * Delivery model:
 *   • Fire-and-forget per-event (does not block the voice pipeline)
 *   • Retry with exponential backoff (1s, 2s, 4s, 8s) up to 4 tries
 *   • Failed events logged but NOT retried beyond the in-memory queue
 *     (full DLQ would need Redis/Bull — out of scope for this phase)
 *
 * Security:
 *   • Each event signed with HMAC-SHA256 of `${timestamp}.${body}` using
 *     the agent's `serverEvents.secret`. The receiver verifies by
 *     re-computing and comparing — replay attacks are mitigated by the
 *     5-minute timestamp window we recommend.
 */

const axios = require('axios');
const crypto = require('crypto');

const MAX_RETRIES = Number(process.env.SERVER_EVENT_MAX_RETRIES || 3);
const TIMEOUT_MS  = Number(process.env.SERVER_EVENT_TIMEOUT_MS || 5000);

const SUPPORTED_EVENTS = new Set([
  'call.started',
  'transcript.segment',
  'sentiment.shift',
  'tool.called',
  'transferred',
  'call.ended',
]);

class ServerEventsDispatcher {
  constructor() {
    this.inflight = 0;
  }

  /**
   * @param {Object} session — voice session (must have agent + callLogId)
   * @param {string} eventType — one of SUPPORTED_EVENTS
   * @param {Object} data — event-specific payload
   */
  emit(session, eventType, data = {}) {
    if (!SUPPORTED_EVENTS.has(eventType)) {
      console.warn(`[ServerEvents] Unknown event type: ${eventType}`);
      return;
    }
    const cfg = session?.agent?.serverEvents;
    if (!cfg || !cfg.url) return;

    // Subscription filter — empty events array means "all"
    if (cfg.events && cfg.events.length > 0 && !cfg.events.includes(eventType)) return;

    const payload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      sessionId: session.id,
      callId: session.callLogId?.toString?.() || null,
      agentId: session.agent?._id?.toString?.() || null,
      data,
    };

    // Fire async — never block the voice loop on webhook delivery.
    this._deliver(cfg.url, cfg.secret, payload).catch(err => {
      console.error(`[ServerEvents] ${eventType} delivery failed:`, err.message);
    });
  }

  async _deliver(url, secret, payload) {
    const body = JSON.stringify(payload);
    const ts = Date.now().toString();

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'VaaniAI-ServerEvents/1.0',
      'X-VaaniAI-Event': payload.event,
      'X-VaaniAI-Timestamp': ts,
    };

    if (secret) {
      const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
      headers['X-VaaniAI-Signature'] = `sha256=${sig}`;
    }

    let lastErr;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.inflight++;
        const res = await axios.post(url, payload, { headers, timeout: TIMEOUT_MS });
        if (res.status >= 200 && res.status < 300) return;
        lastErr = new Error(`status_${res.status}`);
      } catch (err) {
        lastErr = err;
      } finally {
        this.inflight--;
      }
      if (attempt < MAX_RETRIES) {
        const backoff = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  getStats() {
    return { inflight: this.inflight };
  }
}

module.exports = new ServerEventsDispatcher();
