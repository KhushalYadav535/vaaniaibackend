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
    return Number(process.env.GROQ_TIMEOUT_MS || 8000);
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
  async generateResponse({ messages, model = 'llama-3.1-8b-instant', temperature = 0.7, apiKey, tools = null }) {
    if (this.isCircuitOpen()) {
      throw new Error('groq_circuit_open');
    }

    const client = this.getClient(apiKey);
    const start = Date.now();

    const options = {
      messages,
      model,
      temperature,
      max_tokens: 500, // Keep responses concise for voice
    };

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
   */
  async *generateStreamResponse({ messages, model = 'llama-3.1-8b-instant', temperature = 0.7, apiKey }) {
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
          max_tokens: 500,
          stream: true,
        }),
        this.getTimeoutMs(),
        'groq_stream_start'
      );
      this.onRequestSuccess();
    } catch (error) {
      this.onRequestFailure();
      throw error;
    }

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) yield text;
    }
  }

  // Available free models on Groq
  static getAvailableModels() {
    return [
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (Recommended - Fast & Free)', provider: 'groq' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (More capable)', provider: 'groq' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', provider: 'groq' },
      { id: 'gemma-7b-it', name: 'Gemma 7B', provider: 'groq' },
    ];
  }
}

module.exports = new GroqService();
