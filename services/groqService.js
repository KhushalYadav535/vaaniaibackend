/**
 * Groq LLM Service
 * Free tier: llama-3.1-8b-instant, mixtral-8x7b-32768, gemma-7b-it
 * Sign up at: https://console.groq.com
 */
const Groq = require('groq-sdk');

class GroqService {
  constructor() {
    this.clients = new Map(); // Cache clients per API key
    this.breaker = {
      failures: 0,
      openedAt: 0,
    };
  }

  getTimeoutMs() {
    return Number(process.env.GROQ_TIMEOUT_MS || 4000);
  }

  getCircuitFailureThreshold() {
    return Number(process.env.GROQ_CIRCUIT_FAILURE_THRESHOLD || 5);
  }

  getCircuitResetMs() {
    return Number(process.env.GROQ_CIRCUIT_RESET_MS || 20000);
  }

  isCircuitOpen() {
    if (!this.breaker.openedAt) return false;
    const resetMs = this.getCircuitResetMs();
    if (Date.now() - this.breaker.openedAt > resetMs) {
      this.breaker.openedAt = 0;
      this.breaker.failures = 0;
      return false;
    }
    return true;
  }

  onRequestSuccess() {
    this.breaker.failures = 0;
    this.breaker.openedAt = 0;
  }

  onRequestFailure() {
    this.breaker.failures += 1;
    if (this.breaker.failures >= this.getCircuitFailureThreshold()) {
      this.breaker.openedAt = Date.now();
    }
  }

  async withTimeout(promise, timeoutMs, label = 'groq_request') {
    let timeoutHandle;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  getClient(apiKey) {
    const key = apiKey || process.env.GROQ_API_KEY;
    if (!key) throw new Error('No Groq API key. Get one free at https://console.groq.com');

    if (!this.clients.has(key)) {
      this.clients.set(key, new Groq({ apiKey: key }));
    }
    return this.clients.get(key);
  }

  /**
   * Generate LLM response (non-streaming)
   */
  async generateResponse({ messages, model = 'llama-3.1-8b-instant', temperature = 0.7, apiKey, tools = null, jsonMode = false }) {
    if (this.isCircuitOpen()) {
      throw new Error('groq_circuit_open');
    }

    const client = this.getClient(apiKey);
    const start = Date.now();

    const options = {
      messages,
      model,
      temperature,
      // Voice replies should be SHORT (1-3 sentences). 1024 tokens lets
      // the model write essays — which Llama 3.1 8B will, given any
      // remotely open-ended prompt. Cap tunable via env.
      max_tokens: Number(process.env.LLM_MAX_TOKENS || 220),
      // Stop on markdown patterns. Groq caps stop sequences at 4 — these
      // are the highest-impact ones for preventing bullet-list dumps.
      stop: ['\n- ', '\n* ', '\n1.', '\n#'],
    };

    // Structured JSON output mode
    if (jsonMode) {
      options.response_format = { type: 'json_object' };
    }

    if (tools && tools.length > 0) {
      options.tools = tools;
      options.tool_choice = 'auto';
    }

    try {
      const completion = await this.withTimeout(
        client.chat.completions.create(options),
        this.getTimeoutMs(),
        'groq_completion'
      );

      const message = completion.choices[0]?.message;
      const text = message?.content || '';
      const toolCalls = message?.tool_calls || [];
      const latencyMs = Date.now() - start;

      this.onRequestSuccess();
      return { text, toolCalls, latencyMs, model, message };
    } catch (error) {
      this.onRequestFailure();
      throw error;
    }
  }

  /**
   * Generate streaming LLM response
   * Returns async generator of text chunks
   *
   * @param abortSignal — AbortSignal that, when triggered, cancels the
   *   underlying HTTPS request and frees the Groq SDK connection slot.
   *   CRITICAL when interrupts fire mid-stream — without this, the old
   *   stream keeps draining in the background and queues up behind any
   *   new request you make on the same client.
   */
  async *generateStreamResponse({ messages, model = 'llama-3.1-8b-instant', temperature = 0.7, apiKey, abortSignal = null }) {
    if (this.isCircuitOpen()) {
      throw new Error('groq_circuit_open');
    }

    const client = this.getClient(apiKey);

    let stream;
    try {
      stream = await this.withTimeout(
        client.chat.completions.create({
          messages,
          model,
          temperature,
          max_tokens: Number(process.env.LLM_MAX_TOKENS || 220),
          // Same stop sequences as non-streaming path. Groq's hard cap is 4.
          stop: ['\n- ', '\n* ', '\n1.', '\n#'],
          stream: true,
        }, abortSignal ? { signal: abortSignal } : undefined),
        this.getTimeoutMs(),
        'groq_stream_start'
      );
      this.onRequestSuccess();
    } catch (error) {
      this.onRequestFailure();
      throw error;
    }

    try {
      for await (const chunk of stream) {
        if (abortSignal?.aborted) break;
        const text = chunk.choices[0]?.delta?.content || '';
        if (text) yield text;
      }
    } catch (e) {
      // AbortError on signal abort is expected — swallow it so the caller's
      // cancellation path runs cleanly without throwing into the pipeline.
      if (e?.name === 'AbortError' || abortSignal?.aborted) return;
      throw e;
    }
  }

  // Available production models on Groq (auto-tested and verified alive)
  static getAvailableModels() {
    return [
      { id: 'llama-3.1-8b-instant',                              name: 'Llama 3.1 8B Instant (Recommended — Fastest)',  provider: 'groq' },
      { id: 'llama-3.3-70b-versatile',                           name: 'Llama 3.3 70B Versatile (More capable)',         provider: 'groq' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct',         name: 'Llama 4 Scout 17B',                              provider: 'groq' },
      { id: 'qwen/qwen3-32b',                                    name: 'Qwen 3 32B',                                     provider: 'groq' },
      { id: 'openai/gpt-oss-20b',                                name: 'GPT-OSS 20B',                                    provider: 'groq' },
      { id: 'openai/gpt-oss-120b',                               name: 'GPT-OSS 120B (Largest)',                         provider: 'groq' },
    ];
  }
}

module.exports = new GroqService();
