/**
 * Google Gemini LLM Service (FREE Tier)
 * - 60 requests/minute free
 * - gemini-2.0-flash (latest, fast & free)
 * - Also provides FREE text embeddings via text-embedding-004
 *
 * Get free API key: https://aistudio.google.com/apikey
 * Env: GEMINI_API_KEY
 */
const fetch = require('node-fetch');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

class GeminiService {
  constructor() {
    this.breaker = { failures: 0, openedAt: 0 };
  }

  getApiKey(userKey) {
    return userKey || process.env.GEMINI_API_KEY || '';
  }

  /**
   * Master switch — if USE_GEMINI=false (default), Gemini is treated
   * as unavailable everywhere even when the API key is set.
   * This protects the free-tier daily quota for cases where the user
   * only wants Groq (with its own 3-model fallback chain).
   */
  isEnabled() {
    return String(process.env.USE_GEMINI || 'false').toLowerCase() === 'true';
  }

  isAvailable(userKey) {
    if (!this.isEnabled()) return false;
    return !!this.getApiKey(userKey);
  }

  isCircuitOpen() {
    if (!this.breaker.openedAt) return false;
    if (Date.now() - this.breaker.openedAt > 30000) {
      this.breaker = { failures: 0, openedAt: 0 };
      return false;
    }
    return true;
  }

  onSuccess() { this.breaker = { failures: 0, openedAt: 0 }; }
  onFailure() {
    this.breaker.failures++;
    if (this.breaker.failures >= 3) this.breaker.openedAt = Date.now();
  }

  /**
   * Convert OpenAI-style messages to Gemini format
   */
  convertMessages(messages) {
    let systemInstruction = '';
    const contents = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction += (systemInstruction ? '\n' : '') + msg.content;
      } else {
        contents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    // Gemini needs at least one user message
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    return { systemInstruction, contents };
  }

  /**
   * Generate LLM response (non-streaming) — drop-in replacement for groqService.generateResponse
   */
  async generateResponse({ messages, model = 'gemini-2.0-flash', temperature = 0.7, apiKey }) {
    if (this.isCircuitOpen()) throw new Error('gemini_circuit_open');

    const key = this.getApiKey(apiKey);
    if (!key) throw new Error('No Gemini API key configured');

    const { systemInstruction, contents } = this.convertMessages(messages);
    const start = Date.now();

    const url = `${GEMINI_BASE}/models/${model}:generateContent?key=${key}`;

    const body = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: 1024,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    try {
      const resp = await Promise.race([
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('gemini_timeout')), 10000)),
      ]);

      if (!resp.ok) {
        const errBody = await resp.text();
        this.onFailure();
        throw new Error(`Gemini API error ${resp.status}: ${errBody.substring(0, 200)}`);
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const latencyMs = Date.now() - start;

      this.onSuccess();
      return {
        text,
        toolCalls: [],
        latencyMs,
        model,
        message: { role: 'assistant', content: text },
      };
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  /**
   * Generate streaming response — async generator yielding text chunks
   */
  async *generateStreamResponse({ messages, model = 'gemini-2.0-flash', temperature = 0.7, apiKey }) {
    if (this.isCircuitOpen()) throw new Error('gemini_circuit_open');

    const key = this.getApiKey(apiKey);
    if (!key) throw new Error('No Gemini API key configured');

    const { systemInstruction, contents } = this.convertMessages(messages);
    const url = `${GEMINI_BASE}/models/${model}:streamGenerateContent?alt=sse&key=${key}`;

    const body = {
      contents,
      generationConfig: { temperature, maxOutputTokens: 1024 },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    let resp;
    try {
      resp = await Promise.race([
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('gemini_stream_timeout')), 10000)),
      ]);

      if (!resp.ok) {
        this.onFailure();
        throw new Error(`Gemini stream error ${resp.status}`);
      }
      this.onSuccess();
    } catch (error) {
      this.onFailure();
      throw error;
    }

    // Parse SSE stream
    const reader = resp.body;
    let buffer = '';

    for await (const chunk of reader) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(jsonStr);
          const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (text) yield text;
        } catch {
          // skip malformed chunks
        }
      }
    }
  }

  /**
   * Generate text embeddings using FREE Gemini embedding model
   * Returns: float[] vector (768 dimensions)
   */
  async generateEmbedding(text, apiKey) {
    const key = this.getApiKey(apiKey);
    if (!key) throw new Error('No Gemini API key for embeddings');

    const url = `${GEMINI_BASE}/models/text-embedding-004:embedContent?key=${key}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text }] },
      }),
    });

    if (!resp.ok) {
      throw new Error(`Gemini embedding error: ${resp.status}`);
    }

    const data = await resp.json();
    return data.embedding?.values || [];
  }

  /**
   * Batch embed multiple texts
   */
  async generateEmbeddings(texts, apiKey) {
    const key = this.getApiKey(apiKey);
    if (!key) throw new Error('No Gemini API key for embeddings');

    const url = `${GEMINI_BASE}/models/text-embedding-004:batchEmbedContents?key=${key}`;

    const requests = texts.map(text => ({
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
    }));

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });

    if (!resp.ok) {
      throw new Error(`Gemini batch embedding error: ${resp.status}`);
    }

    const data = await resp.json();
    return (data.embeddings || []).map(e => e.values || []);
  }

  static getAvailableModels() {
    return [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash (Recommended — Fast & Free)', provider: 'gemini' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (Latest)', provider: 'gemini' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite (Cheapest)', provider: 'gemini' },
    ];
  }
}

module.exports = new GeminiService();
