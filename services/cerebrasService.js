/**
 * Cerebras LLM Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Cerebras uses Wafer-Scale Engine (WSE) chips — world's fastest LLM inference.
 * Speed: 2000–3000 tokens/sec (vs Groq's 460 tok/sec)
 * Voice TTFT: ~50–100ms
 *
 * FREE TIER: 1,000,000 tokens/day (no credit card needed!)
 * Get API key: https://cloud.cerebras.ai
 * Env var: CEREBRAS_API_KEY
 *
 * API is OpenAI-compatible — same SDK, just different baseURL.
 */

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

class CerebrasService {
  constructor() {
    this.breaker = { failures: 0, openedAt: 0 };
    this._clients = new Map(); // cache per API key
  }

  // ── Master switch ──────────────────────────────────────────────────────────
  isEnabled() {
    return String(process.env.USE_CEREBRAS || 'true').toLowerCase() === 'true';
  }

  isAvailable(userKey) {
    if (!this.isEnabled()) return false;
    return !!(userKey || process.env.CEREBRAS_API_KEY);
  }

  getApiKey(userKey) {
    return userKey || process.env.CEREBRAS_API_KEY || '';
  }

  // ── Circuit breaker ────────────────────────────────────────────────────────
  isCircuitOpen() {
    if (!this.breaker.openedAt) return false;
    const resetMs = Number(process.env.CEREBRAS_CIRCUIT_RESET_MS || 20000);
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
    const threshold = Number(process.env.CEREBRAS_CIRCUIT_FAILURE_THRESHOLD || 5);
    if (this.breaker.failures >= threshold) {
      this.breaker.openedAt = Date.now();
    }
  }

  // ── Lazy OpenAI-compatible client ─────────────────────────────────────────
  _getClient(apiKey) {
    const key = this.getApiKey(apiKey);
    if (!key) throw new Error('No Cerebras API key. Get one FREE at https://cloud.cerebras.ai');

    if (!this._clients.has(key)) {
      // Cerebras is fully OpenAI-compatible — use openai SDK with custom baseURL
      const OpenAI = require('openai');
      this._clients.set(key, new OpenAI({
        apiKey: key,
        baseURL: CEREBRAS_BASE_URL,
        maxRetries: 0, // We own retry logic
        timeout: Number(process.env.CEREBRAS_SDK_TIMEOUT_MS || 8000),
      }));
    }
    return this._clients.get(key);
  }

  // ── Timeout race ───────────────────────────────────────────────────────────
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
   * Generate LLM response (non-streaming)
   * Drop-in replacement for groqService.generateResponse
   */
  async generateResponse({ messages, model, temperature = 0.4, apiKey, tools = null, jsonMode = false }) {
    if (this.isCircuitOpen()) throw new Error('cerebras_circuit_open');

    const resolvedModel = model || process.env.CEREBRAS_DEFAULT_MODEL || 'llama-4-scout-17b-16e-instruct';
    const client = this._getClient(apiKey);
    const start = Date.now();
    const timeoutMs = Number(process.env.CEREBRAS_TIMEOUT_MS || 5000);
    const controller = new AbortController();

    const options = {
      model: resolvedModel,
      messages,
      temperature,
      max_tokens: jsonMode
        ? Number(process.env.LLM_MAX_TOKENS_JSON || 512)
        : Number(process.env.LLM_MAX_TOKENS || 80),
      stop: jsonMode ? undefined : ['\n- ', '\n* ', '\n1.', '\n#'],
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
        'cerebras_completion',
        controller
      );

      const message = completion.choices[0]?.message;
      const text = message?.content || '';
      const toolCalls = message?.tool_calls || [];
      const latencyMs = Date.now() - start;

      this.onSuccess();
      console.log(`[Cerebras] ✅ ${resolvedModel} → ${latencyMs}ms, ${text.length} chars`);
      return { text, toolCalls, latencyMs, model: resolvedModel, message };
    } catch (error) {
      this.onFailure();
      console.warn(`[Cerebras] ❌ ${resolvedModel} → ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate streaming LLM response
   * Returns async generator of text chunks — drop-in for groqService.generateStreamResponse
   */
  async *generateStreamResponse({ messages, model, temperature = 0.4, apiKey, abortSignal = null }) {
    if (this.isCircuitOpen()) throw new Error('cerebras_circuit_open');

    const resolvedModel = model || process.env.CEREBRAS_DEFAULT_MODEL || 'llama-4-scout-17b-16e-instruct';
    const client = this._getClient(apiKey);
    const timeoutMs = Number(process.env.CEREBRAS_TIMEOUT_MS || 5000);

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
        }, { signal: controller.signal }),
        timeoutMs,
        'cerebras_stream_start',
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
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) yield text;
      }
    } catch (e) {
      if (e?.name === 'AbortError' || controller.signal.aborted) return;
      throw e;
    } finally {
      try { controller.abort(); } catch (_) {}
    }
  }

  // ── Available models on Cerebras ──────────────────────────────────────────
  static getAvailableModels() {
    return [
      { id: 'llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B (Recommended — World\'s Fastest)', provider: 'cerebras' },
      { id: 'llama-3.3-70b',                  name: 'Llama 3.3 70B (Smarter)',                           provider: 'cerebras' },
      { id: 'qwen-3-32b',                      name: 'Qwen 3 32B (Alternative)',                          provider: 'cerebras' },
    ];
  }
}

module.exports = new CerebrasService();
