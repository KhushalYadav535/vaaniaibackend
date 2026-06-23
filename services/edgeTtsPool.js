/**
 * Edge TTS WebSocket Connection Pool
 *
 * Microsoft Edge TTS expects:
 *   1. WS connect to wss://speech.platform.bing.com/...?TrustedClientToken=...
 *   2. Client sends `X-RequestId:<id>\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<ssml>`
 *   3. Server streams binary audio chunks (each with `Path:audio\r\n` header)
 *   4. Server sends text frame `Path:turn.end` to mark end of synthesis
 *   5. Same WS can accept the NEXT `Path:ssml` request immediately — no need to reconnect
 *
 * Without a pool, every TTS request pays a fresh ~80-150ms TLS+WS handshake.
 * For a 5-sentence streaming response that's 400-750ms of avoidable latency
 * directly hitting time-to-first-audio (TTFA).
 *
 * This pool keeps a configurable number of warm WS connections ready and
 * gates synthesis requests on a FIFO acquire/release queue. If all sockets
 * are busy and the pool is at max size, the request waits — it never opens
 * an unbounded number of connections.
 */
const WebSocket = require('ws');
const crypto = require('crypto');
const { EdgeTTS } = require('node-edge-tts');

const POOL_SIZE = Number(process.env.EDGE_TTS_POOL_SIZE || 3);
const POOL_MAX_WAIT_MS = Number(process.env.EDGE_TTS_POOL_WAIT_MS || 5000);
const SYNTHESIS_TIMEOUT_MS = Number(process.env.EDGE_TTS_SYNTHESIS_TIMEOUT_MS || 12000);
const IDLE_KEEPALIVE_MS = Number(process.env.EDGE_TTS_IDLE_KEEPALIVE_MS || 60000);

// SSML XML escape — edge cases would break the synthesis request entirely
function escapeXml(unsafe) {
  return String(unsafe).replace(/[<>&"']/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&apos;';
      default: return c;
    }
  });
}

class EdgeTtsPool {
  constructor() {
    this.slots = []; // { ws, busy, voiceId, lastUsedAt }
    this.waiters = []; // resolve fns waiting for an idle slot
    this.creating = 0;
    this._reaperInterval = setInterval(() => this._reapIdle(), 30000);
  }

  /**
   * Open a new WebSocket via the EdgeTTS internal connector. We use the
   * library's own `_connectWebSocket` so we inherit token + URL handling
   * (Microsoft rotates the trusted client token periodically).
   */
  async _openSocket(voiceId) {
    const tts = new EdgeTTS({ voice: voiceId });
    const ws = await tts._connectWebSocket();
    return ws;
  }

  /**
   * Synthesize one SSML payload on a given socket. Resolves with full
   * concatenated MP3 audio buffer. Each call is one logical "turn" on
   * the same WS; the next call can immediately reuse it.
   */
  _synthesizeOnSocket(ws, { text, voiceId, rate, pitchStr, style = null, styleDegree = null }) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const requestId = crypto.randomBytes(16).toString('hex');
      const langCode = voiceId.split('-').slice(0, 2).join('-');

      // Optional <mstts:express-as> emotion wrapper. Only ever passed for
      // voices known to support styles (gated upstream in voicePipeline) —
      // sending it to an unsupported voice makes Edge reject the SSML.
      const prosody = `<prosody rate="${rate}" pitch="${pitchStr}" volume="default">${escapeXml(text)}</prosody>`;
      const inner = style
        ? `<mstts:express-as style="${escapeXml(style)}"${styleDegree ? ` styledegree="${escapeXml(String(styleDegree))}"` : ''}>${prosody}</mstts:express-as>`
        : prosody;

      const cleanup = () => {
        ws.removeListener('message', onMessage);
        ws.removeListener('error', onError);
        ws.removeListener('close', onClose);
        if (timer) clearTimeout(timer);
      };

      const onMessage = (data, isBinary) => {
        if (isBinary) {
          // Edge TTS binary frame format: `Path:audio\r\n` header followed by raw mp3 bytes
          const separator = 'Path:audio\r\n';
          const idx = data.indexOf(separator);
          if (idx >= 0) {
            chunks.push(data.subarray(idx + separator.length));
          }
        } else {
          const message = data.toString();
          if (message.includes('Path:turn.end')) {
            cleanup();
            resolve(Buffer.concat(chunks));
          }
        }
      };
      const onError = (err) => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('edge_tts_socket_closed')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('edge_tts_synthesis_timeout')); }, SYNTHESIS_TIMEOUT_MS);

      ws.on('message', onMessage);
      ws.on('error', onError);
      ws.on('close', onClose);

      try {
        ws.send(
          `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
          `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${langCode}">` +
            `<voice name="${voiceId}">` +
              inner +
            `</voice>` +
          `</speak>`
        );
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  /**
   * Acquire an idle slot. Reuses an existing socket when possible,
   * creates one up to POOL_SIZE, or queues if the pool is saturated.
   */
  async _acquire(voiceId) {
    // Reuse a healthy idle socket
    for (const slot of this.slots) {
      if (!slot.busy && slot.ws.readyState === WebSocket.OPEN) {
        slot.busy = true;
        slot.voiceId = voiceId;
        return slot;
      }
    }

    // Spin up a new socket if room
    if (this.slots.length + this.creating < POOL_SIZE) {
      this.creating++;
      try {
        const ws = await this._openSocket(voiceId);
        const slot = { ws, busy: true, voiceId, lastUsedAt: Date.now() };
        this.slots.push(slot);
        // Drop dead sockets out of the pool immediately so they're never reused
        ws.on('close', () => {
          this._removeSlot(slot);
          // Reject any waiters blocked on this slot that just died
          if (slot.busy && this.waiters.length > 0) {
            const waiter = this.waiters.shift();
            waiter(null, new Error('edge_tts_socket_closed'));
          }
        });
        ws.on('error', () => this._removeSlot(slot));
        return slot;
      } finally {
        this.creating--;
      }
    }

    // Pool saturated — wait for an idle slot
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('edge_tts_pool_acquire_timeout'));
      }, POOL_MAX_WAIT_MS);
      const waiter = (slot, err) => {
        clearTimeout(timer);
        if (err || !slot) return reject(err || new Error('edge_tts_pool_slot_dead'));
        slot.voiceId = voiceId;
        resolve(slot);
      };
      this.waiters.push(waiter);
    });
  }

  _release(slot) {
    if (!slot) return;
    slot.busy = false;
    slot.lastUsedAt = Date.now();
    // Hand off to the next waiter if any
    if (this.waiters.length > 0 && slot.ws.readyState === WebSocket.OPEN) {
      const waiter = this.waiters.shift();
      slot.busy = true;
      waiter(slot, null);
    }
  }

  _removeSlot(slot) {
    const idx = this.slots.indexOf(slot);
    if (idx >= 0) this.slots.splice(idx, 1);
  }

  _reapIdle() {
    const now = Date.now();
    for (const slot of [...this.slots]) {
      if (!slot.busy && now - slot.lastUsedAt > IDLE_KEEPALIVE_MS) {
        try { slot.ws.close(); } catch (_) {}
        this._removeSlot(slot);
      }
    }
  }

  /**
   * Public API — feature-equivalent to a one-shot Edge TTS call but
   * routed through the connection pool.
   */
  async synthesize({ text, voiceId, speed = 1.0, pitch = 0, style = null, styleDegree = null }) {
    if (!text || !text.trim()) return Buffer.alloc(0);
    const rate = `${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
    const pitchStr = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;

    // Two retries: handles the race where a pooled socket gets closed by
    // the server right as we send. The retry will open a fresh socket.
    // `styleFailed` lets us drop the express-as wrapper if the server
    // rejected it (some voice/style pairs are unsupported) so the user
    // still hears the line — just without the emotion styling.
    let lastErr;
    let styleFailed = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      let slot;
      try {
        slot = await this._acquire(voiceId);
      } catch (acquireErr) {
        // Could not get a slot (timeout, all dead) — bail out immediately
        throw acquireErr;
      }
      try {
        const effStyle = styleFailed ? null : style;
        const audio = await this._synthesizeOnSocket(slot.ws, {
          text, voiceId, rate, pitchStr, style: effStyle, styleDegree: effStyle ? styleDegree : null,
        });
        this._release(slot);
        return audio;
      } catch (err) {
        // If we sent a style and the socket died, the express-as wrapper is
        // the most likely culprit — retry once WITHOUT it before giving up.
        if (style && !styleFailed) styleFailed = true;
        // Socket is hosed — drop it so we don't reuse a broken WS
        try { slot.ws.close(); } catch (_) {}
        this._removeSlot(slot);
        lastErr = err;
        // Small back-off before retry so a new socket has time to open
        if (attempt === 0) await new Promise(r => setTimeout(r, 200));
      }
    }
    throw lastErr || new Error('edge_tts_synthesis_failed');
  }

  getStats() {
    return {
      slots: this.slots.length,
      busy: this.slots.filter(s => s.busy).length,
      waiters: this.waiters.length,
      maxSize: POOL_SIZE,
    };
  }
}

module.exports = new EdgeTtsPool();
