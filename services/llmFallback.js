/**
 * LLM Last-Resort Fallback
 *
 * When BOTH Groq and Gemini fail (free-tier rate limits, network issues,
 * circuit breakers open), the call would otherwise die mid-turn. That's
 * a worse user experience than a slightly canned reply.
 *
 * This module provides two behaviours, in order:
 *   1. Recent-response cache — if a similar user message was answered
 *      successfully in the last N minutes, replay that response.
 *   2. Intent-keyword templates — basic patterns (greeting, thanks,
 *      goodbye, repeat-request) get language-aware canned replies.
 *   3. Generic apology — keeps the call alive with "let me try that
 *      again" and lets the next turn retry the real LLM.
 *
 * Cache hits use the EXACT same TTS pipeline downstream so the user
 * doesn't notice anything — only the answer source changes.
 */

const CACHE_MAX_ENTRIES = Number(process.env.LLM_FALLBACK_CACHE_MAX || 200);
const CACHE_TTL_MS = Number(process.env.LLM_FALLBACK_CACHE_TTL_MS || 60 * 60 * 1000);

class LlmFallback {
  constructor() {
    // key: normalized user text → { reply, ts }
    this.cache = new Map();
  }

  /** Normalize a user message into a coarse cache key. */
  _key(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  /** Record a successful (user → assistant) pair for future fallback. */
  remember(userText, assistantReply) {
    if (!userText || !assistantReply) return;
    const key = this._key(userText);
    if (!key || key.length < 4) return;

    // Evict oldest if at capacity
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }

    this.cache.set(key, { reply: assistantReply, ts: Date.now() });
  }

  _cacheLookup(userText) {
    const key = this._key(userText);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }
    return entry.reply;
  }

  /** Intent-based templated responses, language-aware. */
  _templateMatch(text, lang) {
    const t = String(text || '').toLowerCase().trim();
    if (!t) return null;

    const isHindi = lang === 'hi' || lang === 'hi-Latn' || lang === 'multi' || lang === 'en-IN';

    // Greetings
    if (/^(hello|hi|hey|namaste|namaskar|hola)\b/.test(t)) {
      return isHindi ? 'Namaste! Boliye, kaise madad kar sakta hoon?' : 'Hey there! How can I help?';
    }

    // Thanks
    if (/\b(thank|thanks|shukriya|dhanyavad|dhanyavaad)\b/.test(t)) {
      return isHindi ? 'Koi baat nahi.' : 'You\'re welcome.';
    }

    // Goodbye is handled upstream (shouldEndCall) but defend anyway
    if (/\b(bye|goodbye|alvida|chalo)\b/.test(t)) {
      return isHindi ? 'Theek hai, dhanyavad. Phir milte hain.' : 'Alright, take care.';
    }

    // Repeat request
    if (/\b(repeat|again|kya bola|samjha nahi|didn'?t catch|sorry what)\b/.test(t)) {
      return isHindi ? 'Maaf kijiye, ek minute, main thodi der mein wapas aata hoon.' : 'Sorry — give me one moment, I\'ll be right back.';
    }

    // Yes / no acknowledgments — keep moving without sounding broken
    if (/^(yes|yeah|yep|haan|ji|sure|ok|okay)\b/.test(t)) {
      return isHindi ? 'Theek hai. Aage boliye.' : 'Got it. Go ahead.';
    }
    if (/^(no|nope|nahi|nahin)\b/.test(t)) {
      return isHindi ? 'Theek hai. Aur kuch?' : 'Okay. Anything else?';
    }

    return null;
  }

  /**
   * Produce a last-resort reply. Always returns SOMETHING usable —
   * never throws, never returns empty string.
   */
  getReply(userText, agent = {}) {
    const lang = agent.language || 'en';

    // 1. Try cache hit on this exact user phrasing
    const cached = this._cacheLookup(userText);
    if (cached) {
      console.log('[LLM Fallback] Cache hit — replaying recent response');
      return { text: cached, source: 'cache' };
    }

    // 2. Intent-keyword template
    const template = this._templateMatch(userText, lang);
    if (template) {
      console.log('[LLM Fallback] Template match — using canned response');
      return { text: template, source: 'template' };
    }

    // 3. Generic apology that keeps the call alive
    console.log('[LLM Fallback] Using generic apology');
    const isHindi = lang === 'hi' || lang === 'hi-Latn' || lang === 'multi' || lang === 'en-IN';
    return {
      text: isHindi
        ? 'Maaf kijiye, ek second, system thoda busy hai. Phir se boliye?'
        : 'Sorry, having a tiny hiccup on my end. Could you say that again?',
      source: 'apology',
    };
  }

  getStats() {
    return {
      cacheSize: this.cache.size,
      maxSize: CACHE_MAX_ENTRIES,
      ttlMs: CACHE_TTL_MS,
    };
  }
}

module.exports = new LlmFallback();
