/**
 * OpenRouter LLM Service
 * ─────────────────────────────────────────────────────────────────────────────
 * OpenRouter is a paid, OpenAI-compatible gateway that routes a single request
 * to many upstream providers (Cerebras, Groq, SambaNova, Fireworks, Google…).
 *
 * Why we use it as the PRIMARY path when a key is present:
 *   - Pay-as-you-go → NO free-tier TPM wall. Groq free tier (6000 TPM) was
 *     429-ing on almost every Hindi turn (each request ≈ 5000 input tokens),
 *     which forced a slow 70B fallback and inflated TTFT to ~1500ms.
 *   - Provider routing: with `provider.sort = 'throughput'` OpenRouter picks the
 *     FASTEST upstream (often Cerebras/Groq) automatically, and `allow_fallbacks`
 *     means a throttled provider transparently rolls to the next — no 429 storm.
 *
 * API is OpenAI-compatible — same `openai` SDK, just a different baseURL +
 * OpenRouter's optional ranking headers. This mirrors cerebrasService.js so it's
 * a drop-in for the same generateResponse / generateStreamResponse interface.
 *
 * FREE? No — it spends your OpenRouter credits. But fast Hindi-capable models
 * (Llama 3.3 70B, Gemini Flash) are cheap enough that a few dollars = thousands
 * of voice turns. Groq/Gemini remain wired BELOW this as a free safety net.
 *
 * Get a key: https://openrouter.ai/keys   Env var: OPENROUTER_API_KEY
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

class OpenRouterService {
  constructor() {
    this.breaker = { failures: 0, openedAt: 0 };
    this._clients = new Map(); // cache per API key
  }

  // ── Master switch ──────────────────────────────────────────────────────────
  isEnabled() {
    return String(process.env.USE_OPENROUTER || 'true').toLowerCase() === 'true';
  }

  isAvailable(userKey) {
    if (!this.isEnabled()) return false;
    return !!(userKey || process.env.OPENROUTER_API_KEY);
  }

  getApiKey(userKey) {
    return userKey || process.env.OPENROUTER_API_KEY || '';
  }

  defaultModel() {
    // Llama 3.3 70B: strong Hindi, and OpenRouter routes it through the fastest
    // provider (Cerebras/Groq) when we sort by throughput. Override per-deploy
    // with OPENROUTER_MODEL (e.g. google/gemini-2.0-flash-001).
    return process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct';
  }

  /**
   * OpenRouter provider-routing preferences, merged into the request body.
   * `sort: throughput` → fastest upstream first (best for voice TTFT).
   * `allow_fallbacks` → silently roll to the next provider if one is throttled,
   * which is exactly what kills the 429 storm we saw on Groq's free tier.
   */
  _providerRouting() {
    const sort = process.env.OPENROUTER_PROVIDER_SORT || 'throughput';
    const allowFallbacks = String(process.env.OPENROUTER_ALLOW_FALLBACKS || 'true').toLowerCase() === 'true';
    const routing = { sort, allow_fallbacks: allowFallbacks };
    // Optional hard pin to specific providers, e.g. "Cerebras,Groq".
    const order = (process.env.OPENROUTER_PROVIDER_ORDER || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (order.length > 0) routing.order = order;
    return routing;
  }

  // ── Circuit breaker ────────────────────────────────────────────────────────
  isCircuitOpen() {
    if (!this.breaker.openedAt) return false;
    const resetMs = Number(process.env.OPENROUTER_CIRCUIT_RESET_MS || 20000);
    if (Date.now() - this.breaker.openedAt > resetMs) {
      this.breaker = { failures: 0, openedAt: 0 };
      return false;
    }
    return true;
  }

  onSuccess() {
    this.breaker = { failures: 0, openedAt: 0 };
  }

  onFailure() {
    this.breaker.failures += 1;
    const threshold = Number(process.env.OPENROUTER_CIRCUIT_FAILURE_THRESHOLD || 5);
    if (this.breaker.failures >= threshold) {
      this.breaker.openedAt = Date.now();
    }
  }

  // ── Lazy OpenAI-compatible client ─────────────────────────────────────────
  _getClient(apiKey) {
    const key = this.getApiKey(apiKey);
    if (!key) throw new Error('No OpenRouter API key. Get one at https://openrouter.ai/keys');

    if (!this._clients.has(key)) {
      const OpenAI = require('openai');
      this._clients.set(key, new OpenAI({
        apiKey: key,
        baseURL: OPENROUTER_BASE_URL,
        maxRetries: 0, // We own retry/fallback policy
        timeout: Number(process.env.OPENROUTER_SDK_TIMEOUT_MS || 8000),
        // OpenRouter's optional ranking headers (harmless if unset).
        defaultHeaders: {
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || process.env.FRONTEND_URL || 'https://vaani.ai',
          'X-Title': process.env.OPENROUTER_SITE_NAME || 'VaaniAI',
        },
      }));
    }
    return this._clients.get(key);
  }

  // ── Timeout race (aborts the losing request so it can't hold a pool slot) ──
  async _withTimeout(promise, timeoutMs, label, controller = null) {
    let handle;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          handle = setTimeout(() => {
            if (controller) { try { controller.abort(); } catch (_) {} }
            reject(new Error(`${label}_timeout`));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (handle) clearTimeout(handle);
    }
  }

  /**
   * Generate LLM response (non-streaming).
   * Drop-in replacement for groqService.generateResponse.
   */
  async generateResponse({ messages, model, temperature = 0.4, apiKey, tools = null, jsonMode = false }) {
    if (this.isCircuitOpen()) throw new Error('openrouter_circuit_open');

    const resolvedModel = model || this.defaultModel();
    const client = this._getClient(apiKey);
    const start = Date.now();
    const timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS || 6000);
    const controller = new AbortController();

    const options = {
      model: resolvedModel,
      messages,
      temperature,
      max_tokens: jsonMode
        ? Number(process.env.LLM_MAX_TOKENS_JSON || 512)
        : Number(process.env.LLM_MAX_TOKENS || 80),
      stop: jsonMode ? undefined : ['\n- ', '\n* ', '\n1.', '\n#'],
      provider: this._providerRouting(),
    };

    if (jsonMode) {
      options.response_format = { type: 'json_object' };
    }

    if (tools && tools.length > 0) {
      options.tools = tools;
      options.tool_choice = 'auto';
    }

    try {
      const completion = await this._withTimeout(
        client.chat.completions.create(options, { signal: controller.signal }),
        timeoutMs,
        'openrouter_completion',
        controller
      );

      const message = completion.choices[0]?.message;
      const text = message?.content || '';
      const toolCalls = message?.tool_calls || [];
      const latencyMs = Date.now() - start;

      this.onSuccess();
      console.log(`[OpenRouter] ✅ ${resolvedModel} → ${latencyMs}ms, ${text.length} chars`);
      return { text, toolCalls, latencyMs, model: resolvedModel, message };
    } catch (error) {
      this.onFailure();
      console.warn(`[OpenRouter] ❌ ${resolvedModel} → ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate streaming LLM response.
   * Returns async generator of text chunks — drop-in for groqService.generateStreamResponse.
   */
  async *generateStreamResponse({ messages, model, temperature = 0.4, apiKey, abortSignal = null }) {
    if (this.isCircuitOpen()) throw new Error('openrouter_circuit_open');

    const resolvedModel = model || this.defaultModel();
    const client = this._getClient(apiKey);
    const timeoutMs = Number(process.env.OPENROUTER_STREAM_START_TIMEOUT_MS || process.env.OPENROUTER_TIMEOUT_MS || 6000);

    const controller = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) controller.abort();
      else abortSignal.addEventListener('abort', () => {
        try { controller.abort(); } catch (_) {}
      }, { once: true });
    }

    let stream;
    try {
      stream = await this._withTimeout(
        client.chat.completions.create({
          model: resolvedModel,
          messages,
          temperature,
          max_tokens: Number(process.env.LLM_MAX_TOKENS || 80),
          stop: ['\n- ', '\n* ', '\n1.', '\n#'],
          stream: true,
          provider: this._providerRouting(),
        }, { signal: controller.signal }),
        timeoutMs,
        'openrouter_stream_start',
        controller
      );
      this.onSuccess();
    } catch (error) {
      this.onFailure();
      throw error;
    }

    try {
      for await (const chunk of stream) {
        if (controller.signal.aborted) break;
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) yield text;
      }
    } catch (e) {
      if (e?.name === 'AbortError' || controller.signal.aborted) return;
      throw e;
    } finally {
      try { controller.abort(); } catch (_) {}
    }
  }

  // ── A few fast, Hindi-capable defaults worth surfacing in the UI ───────────
  static getAvailableModels() {
    return [
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B (Recommended — fast + strong Hindi)', provider: 'openrouter' },
      { id: 'google/gemini-2.0-flash-001',       name: 'Gemini 2.0 Flash (very fast, great Hindi)',         provider: 'openrouter' },
      { id: 'meta-llama/llama-3.1-8b-instruct',  name: 'Llama 3.1 8B (cheapest, lowest latency)',           provider: 'openrouter' },
    ];
  }
}

module.exports = new OpenRouterService();
