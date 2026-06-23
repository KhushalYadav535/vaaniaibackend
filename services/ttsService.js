/**
 * TTS Service using node-edge-tts
 * 100% FREE - Uses Microsoft Edge's online TTS service
 * No API key needed! Zero cost!
 *
 * Install: npm install node-edge-tts
 */
const { EdgeTTS } = require('node-edge-tts');
const { Readable } = require('stream');
const fetch = require('node-fetch');
const crypto = require('crypto');
const edgeTtsPool = require('./edgeTtsPool');

const USE_TTS_POOL = String(process.env.EDGE_TTS_POOL_ENABLED || 'true').toLowerCase() === 'true';

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise(resolve => this.queue.push(resolve));
  }
  release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next();
    } else {
      this.active--;
    }
  }
}

// Cartesia Free tier allows max 2 concurrent connections.
const cartesiaSemaphore = new Semaphore(2);

/**
 * LRU Cache for TTS audio buffers.
 * Avoids regenerating audio for repeated phrases (fillers, greetings, FAQ answers).
 * Default: 200 entries, ~100MB max.
 */
class TTSCache {
  constructor(maxEntries = 200, maxBytes = 100 * 1024 * 1024) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.cache = new Map(); // key → { buffer, size, accessedAt }
    this.totalBytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  _key(text, voiceId, speed, provider, style = null) {
    // style is part of the key so an "empathetic" render and a neutral
    // render of the same text don't collide in the cache.
    const styleTag = style ? `:${style}` : '';
    return crypto.createHash('md5').update(`${provider}:${voiceId}:${speed}${styleTag}:${text}`).digest('hex');
  }

  get(text, voiceId, speed, provider, style = null) {
    const key = this._key(text, voiceId, speed, provider, style);
    const entry = this.cache.get(key);
    if (entry) {
      this.hits++;
      entry.accessedAt = Date.now();
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.buffer;
    }
    this.misses++;
    return null;
  }

  set(text, voiceId, speed, provider, buffer, style = null) {
    if (!buffer || buffer.length === 0) return;
    const key = this._key(text, voiceId, speed, provider, style);

    // Don't cache very large audio (> 512KB)
    if (buffer.length > 512 * 1024) return;

    // Evict if needed
    while (this.cache.size >= this.maxEntries || this.totalBytes + buffer.length > this.maxBytes) {
      const oldestKey = this.cache.keys().next().value;
      if (!oldestKey) break;
      const evicted = this.cache.get(oldestKey);
      this.totalBytes -= evicted.size;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, { buffer, size: buffer.length, accessedAt: Date.now() });
    this.totalBytes += buffer.length;
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      totalMB: (this.totalBytes / 1024 / 1024).toFixed(1),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? ((this.hits / total) * 100).toFixed(1) + '%' : '0%',
    };
  }
}

class TtsService {
  constructor() {
    const maxEntries = Number(process.env.TTS_CACHE_MAX_ENTRIES || 200);
    const maxMB = Number(process.env.TTS_CACHE_MAX_MB || 100);
    this.cache = new TTSCache(maxEntries, maxMB * 1024 * 1024);
    this._cacheEnabled = String(process.env.TTS_CACHE_ENABLED || 'true').toLowerCase() === 'true';
  }
  /**
   * Convert text to speech audio buffer
   * Returns: Buffer containing MP3 audio
   */
  async textToSpeech({ text, voiceId = 'en-US-JennyNeural', speed = 1.0, pitch = 0, apiKey = null, provider = 'edge-tts', style = null, styleDegree = null }) {
    if (!text || text.trim().length === 0) return Buffer.alloc(0);

    // express-as is an Edge-TTS-only feature. For any other provider, ignore
    // the style so it never leaks into the cache key or a non-Edge request.
    if (provider !== 'edge-tts') style = null;

    // ── Check cache first ─────────────────────────────────────────────
    if (this._cacheEnabled) {
      const cached = this.cache.get(text, voiceId, speed, provider, style);
      if (cached) return cached;
    }

    let audioBuffer;

    // Respect selected provider. Use ElevenLabs only when explicitly requested.
    if (provider === 'eleven-labs' && (apiKey || process.env.ELEVENLABS_API_KEY)) {
      try {
        audioBuffer = await this.elevenLabsTTS(text, voiceId, apiKey || process.env.ELEVENLABS_API_KEY);
      } catch (e) {
        console.error('ElevenLabs TTS failed, falling back to Edge:', e.message);
      }
    } else if (provider === 'cartesia' && (apiKey || process.env.CARTESIA_API_KEY)) {
      try {
        audioBuffer = await this.cartesiaTTS(text, voiceId, apiKey || process.env.CARTESIA_API_KEY);
      } catch (e) {
        console.error('Cartesia TTS failed, falling back to Edge:', e.message);
      }
    }

    // Default to Edge TTS (Free)
    if (!audioBuffer) {
      // Try pooled connection first — saves ~80-150ms WS handshake per call.
      // Falls through to a fresh WS (in-memory then file) if the pool errors.
      if (USE_TTS_POOL) {
        try {
          audioBuffer = await edgeTtsPool.synthesize({ text, voiceId, speed, pitch, style, styleDegree });
        } catch (e) {
          console.error('Edge TTS pool failed, falling back to fresh WS:', e.message);
        }
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        try {
          audioBuffer = await this.edgeTTSInMemory(text, voiceId, speed, pitch, style, styleDegree);
        } catch (e) {
          console.error('Edge TTS in-memory failed, trying file fallback:', e.message);
          // File fallback (node-edge-tts) has no style support — degrade gracefully.
          audioBuffer = await this.edgeTTSFileFallback(text, voiceId, speed, pitch);
        }
      }
    }

    // ── Store in cache ────────────────────────────────────────────────
    if (this._cacheEnabled && audioBuffer && audioBuffer.length > 0) {
      this.cache.set(text, voiceId, speed, provider, audioBuffer, style);
    }

    return audioBuffer || Buffer.alloc(0);
  }

  async edgeTTSInMemory(text, voiceId, speed, pitch, style = null, styleDegree = null) {
    const rate = `${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
    const pitchStr = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;

    const tts = new EdgeTTS({ voice: voiceId, rate, pitch: pitchStr });

    // Connect to WebSocket using internal method
    const _wsConnect = await tts._connectWebSocket();

    return new Promise((resolve, reject) => {
      const chunks = [];
      let timeout = setTimeout(() => {
        _wsConnect.close();
        reject(new Error('Edge TTS Timed out'));
      }, 15000); // 15s timeout for fast failure

      _wsConnect.on('message', async (data, isBinary) => {
        if (isBinary) {
          const separator = 'Path:audio\r\n';
          const index = data.indexOf(separator) + separator.length;
          const audioData = data.subarray(index);
          chunks.push(audioData);
        } else {
          const message = data.toString();
          if (message.includes('Path:turn.end')) {
            clearTimeout(timeout);
            _wsConnect.close();
            const audio = Buffer.concat(chunks);
            resolve(audio);
          }
        }
      });

      _wsConnect.on('error', (err) => {
        clearTimeout(timeout);
        // If an express-as style was applied, it's the most likely cause of
        // an SSML rejection. Retry once WITHOUT the style so the user still
        // hears the line (just without emotion styling).
        if (style) {
          this.edgeTTSInMemory(text, voiceId, speed, pitch, null, null).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      const crypto = require('crypto');
      const requestId = crypto.randomBytes(16).toString('hex');

      // Escape XML to avoid breaking SSML
      const escapeXml = (unsafe) => unsafe.replace(/[<>&"']/g, c => {
        switch (c) {
          case '<': return '&lt;'; case '>': return '&gt;';
          case '&': return '&amp;'; case '"': return '&quot;';
          case "'": return '&apos;'; default: return c;
        }
      });

      const langCode = voiceId.split('-').slice(0, 2).join('-');
      // Optional <mstts:express-as> emotion wrapper (Edge TTS only).
      const prosody = `<prosody rate="${rate}" pitch="${pitchStr}" volume="default">${escapeXml(text)}</prosody>`;
      const inner = style
        ? `<mstts:express-as style="${escapeXml(style)}"${styleDegree ? ` styledegree="${escapeXml(String(styleDegree))}"` : ''}>${prosody}</mstts:express-as>`
        : prosody;
      _wsConnect.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` +
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${langCode}">` +
        `<voice name="${voiceId}">` +
        `${inner}` +
        `</voice></speak>`
      );
    });
  }

  /**
   * Edge TTS — file-based fallback (original approach)
   */
  async edgeTTSFileFallback(text, voiceId, speed, pitch) {
    try {
      const path = require('path');
      const fs = require('fs/promises');
      const os = require('os');

      const rate = `${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
      const pitchStr = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;

      const tts = new EdgeTTS({ voice: voiceId, rate, pitch: pitchStr });
      const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.floor(Math.random()*1000)}.mp3`);
      
      await tts.ttsPromise(text, tmpFile);
      const audio = await fs.readFile(tmpFile);
      fs.unlink(tmpFile).catch(() => {});
      
      return audio;
    } catch (e) {
      console.error('Edge TTS file fallback error:', e?.message || String(e));
      return Buffer.alloc(0);
    }
  }

  /**
   * Pre-warm cache with common phrases (call at startup or agent init)
   * Generates audio for filler words and common responses ahead of time
   */
  async prewarmCache(voiceId = 'en-US-JennyNeural', speed = 1.0, provider = 'edge-tts') {
    const phrases = [
      'Hmm...', 'Let me see...', 'Umm...', 'Okay...', 'Well...',
      'One moment please.', 'Let me check that for you.',
      'Sure!', 'Of course.', 'Absolutely.',
      'I understand.', 'Got it.',
    ];

    let warmed = 0;
    for (const phrase of phrases) {
      try {
        await this.textToSpeech({ text: phrase, voiceId, speed, provider });
        warmed++;
      } catch (e) { /* skip failures */ }
    }
    console.log(`[TTS Cache] Pre-warmed ${warmed}/${phrases.length} phrases for ${voiceId}`);
  }

  getCacheStats() {
    return this.cache.getStats();
  }

  /**
   * ElevenLabs TTS — WebSocket Streaming Implementation
   *
   * OLD (REST): Send full sentence → wait 300-500ms → get full audio buffer
   * NEW (WS):   Send text chunk → get audio chunk ~100-150ms → accumulate
   *
   * The WebSocket endpoint streams audio back as it generates, cutting
   * first-audio latency from ~400ms to ~150ms. Uses eleven_flash_v2_5
   * for lowest latency. Falls back to REST if WS fails.
   */
  async elevenLabsTTS(text, voiceId, apiKey) {
    // If voiceId is an Edge voice (config mismatch: provider=eleven-labs but an
    // Edge voiceId is still set), fall back to a default ElevenLabs voice.
    // The default is env-configurable so each deployment can point at a
    // multilingual / Indian-accent voice without a code change. Old hardcoded
    // default was '21m00Tcm4TlvDq8ikWAM' (Rachel — English), which gave Hindi
    // agents an English-accented voice. eleven_flash/turbo_v2_5 are multilingual,
    // so any voice can speak Hindi, but a native-sounding voice is better.
    const defaultVoiceId = process.env.ELEVENLABS_DEFAULT_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
    const elVoiceId = voiceId.includes('Neural') ? defaultVoiceId : voiceId;

    try {
      return await this._elevenLabsWebSocket(text, elVoiceId, apiKey);
    } catch (wsErr) {
      console.warn('[ElevenLabs] WebSocket TTS failed, falling back to REST:', wsErr.message);
      return await this._elevenLabsREST(text, elVoiceId, apiKey);
    }
  }

  /**
   * Voice settings tuned for live conversational agents (not audiobook reading).
   * - stability LOWER (0.35): more expressive, less monotone on short replies.
   * - similarity_boost HIGHER (0.75): stays closer to the chosen voice's timbre.
   * - style 0: no exaggeration (keeps latency low on flash/turbo models).
   * - use_speaker_boost: clearer, more present voice on phone audio.
   * All four are env-tunable so you can dial them in per deployment without a
   * redeploy. Shared by BOTH the WebSocket and REST paths so they never drift.
   */
  _elevenLabsVoiceSettings() {
    const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
    return {
      stability: num(process.env.ELEVENLABS_STABILITY, 0.35),
      similarity_boost: num(process.env.ELEVENLABS_SIMILARITY, 0.75),
      style: num(process.env.ELEVENLABS_STYLE, 0),
      use_speaker_boost: String(process.env.ELEVENLABS_SPEAKER_BOOST || 'true').toLowerCase() === 'true',
    };
  }

  /**
   * Pick a REST-compatible model. The WS streaming path defaults to
   * 'eleven_flash_v2_5', but flash models are optimized for the streaming
   * (stream-input) endpoint; the REST /stream endpoint is safest with the
   * turbo line. If ELEVENLABS_MODEL is a turbo model we honor it; otherwise
   * we use turbo_v2_5 (multilingual, ~250-300ms, supports Hindi).
   */
  _elevenLabsRestModel() {
    const m = process.env.ELEVENLABS_MODEL || '';
    return m.startsWith('eleven_turbo') ? m : 'eleven_turbo_v2_5';
  }

  /**
   * ElevenLabs WebSocket streaming — sends text, receives audio chunks in real-time.
   * Protocol: wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
   *
   * Message flow:
   *   Client → { text: "Hello ", voice_settings: {...} }  (first chunk with settings)
   *   Client → { text: "world! ", flush: true }           (last chunk, flush buffer)
   *   Client → { text: "" }                               (EOS signal: empty string closes generation)
   *   Server → { audio: "<base64>", ... }                 (audio chunks as they generate)
   *   Server → close                                      (done)
   */
  _elevenLabsWebSocket(text, voiceId, apiKey) {
    const WebSocket = require('ws');

    return new Promise((resolve, reject) => {
      const modelId = process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';
      const outputFormat = 'mp3_44100_128'; // MP3, consistent with REST output
      const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=${outputFormat}`;

      const ws = new WebSocket(url, {
        headers: { 'xi-api-key': apiKey },
      });

      const audioChunks = [];
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          try { ws.close(); } catch (_) {}
          reject(new Error('ElevenLabs WS timeout (10s)'));
        }
      }, 10000);

      ws.on('open', () => {
        // Send text with voice settings in first message, then flush + EOS
        ws.send(JSON.stringify({
          text: text + ' ', // trailing space helps ElevenLabs buffer
          voice_settings: this._elevenLabsVoiceSettings(),
          flush: true,
        }));

        // Send empty string as EOS (End-of-Sequence) to signal generation complete
        ws.send(JSON.stringify({ text: '' }));
      });

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.audio) {
            // Audio comes as base64-encoded chunks
            audioChunks.push(Buffer.from(msg.audio, 'base64'));
          }
          // msg.isFinal === true means this is the last audio chunk
          if (msg.isFinal) {
            clearTimeout(timeout);
            if (!resolved) {
              resolved = true;
              try { ws.close(); } catch (_) {}
              resolve(Buffer.concat(audioChunks));
            }
          }
        } catch (_) { /* ignore parse errors */ }
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          if (audioChunks.length > 0) {
            resolve(Buffer.concat(audioChunks));
          } else {
            reject(new Error('ElevenLabs WS closed without audio'));
          }
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        if (!resolved) {
          resolved = true;
          reject(new Error('ElevenLabs WS error: ' + (err.message || err)));
        }
      });
    });
  }

  /**
   * ElevenLabs REST fallback (original implementation)
   * Used when WebSocket connection fails
   */
  async _elevenLabsREST(text, voiceId, apiKey) {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        // Keep REST in sync with the WS path's model choice. Falls back to
        // turbo_v2_5 (multilingual, low-latency) if ELEVENLABS_MODEL is unset
        // or is a WS-only flash model that REST doesn't accept.
        model_id: this._elevenLabsRestModel(),
        text,
        voice_settings: this._elevenLabsVoiceSettings(),
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail?.message || 'ElevenLabs API error');
    }

    return await response.buffer();
  }

  /**
   * Cartesia TTS Implementation
   * Uses REST API for low latency TTS
   */
  async cartesiaTTS(text, voiceId, apiKey) {
    // If voiceId looks like an Edge TTS voice, fallback to a default Cartesia voice
    const isEdgeVoice = voiceId.includes('Neural');
    // We map specific Edge voices to Cartesia voice IDs.
    // Nisha (F) is the default native Indian female voice.
    const cartesiaVoiceId = isEdgeVoice ? '0f14d8cb-f039-41fe-a813-a9b4bee7eed8' : voiceId;
    
    // Cartesia consolidated their models into a single 'sonic-3.5' model.
    // 'sonic-english' and 'sonic-multilingual' are sunsetted.
    const modelId = 'sonic-3.5';

    await cartesiaSemaphore.acquire();
    try {
      const response = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'Cartesia-Version': '2024-06-10',
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({
          model_id: modelId,
          transcript: text,
          voice: {
            mode: 'id',
            id: cartesiaVoiceId
          },
          output_format: {
            container: 'mp3',
            encoding: 'pcm_f32le',
            sample_rate: 44100
          }
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Cartesia API error (${response.status}): ${error}`);
      }

      return await response.buffer();
    } finally {
      cartesiaSemaphore.release();
    }
  }

  /**
   * Stream TTS audio (for real-time use)
   */
  async *streamTextToSpeech({ text, voiceId = 'en-US-JennyNeural', speed = 1.0 }) {
    const audio = await this.textToSpeech({ text, voiceId, speed });
    // Chunk audio into 4KB pieces for streaming
    const chunkSize = 4096;
    for (let i = 0; i < audio.length; i += chunkSize) {
      yield audio.slice(i, i + chunkSize);
    }
  }

  /**
   * Get available Edge TTS voices (free)
   */
  static getAvailableVoices() {
    return [
      // ── Hindi ─────────────────────────────────────────────────
      { id: 'hi-IN-SwaraNeural',    name: '🇮🇳 Swara — Hindi Female (Recommended)', lang: 'hi-IN', gender: 'Female' },
      { id: 'hi-IN-MadhurNeural',   name: '🇮🇳 Madhur — Hindi Male',                lang: 'hi-IN', gender: 'Male'   },
      // ── Tamil ─────────────────────────────────────────────────
      { id: 'ta-IN-PallaviNeural',  name: '🇮🇳 Pallavi — Tamil Female',             lang: 'ta-IN', gender: 'Female' },
      { id: 'ta-IN-ValluvarNeural', name: '🇮🇳 Valluvar — Tamil Male',              lang: 'ta-IN', gender: 'Male'   },
      // ── Telugu ────────────────────────────────────────────────
      { id: 'te-IN-ShrutiNeural',   name: '🇮🇳 Shruti — Telugu Female',             lang: 'te-IN', gender: 'Female' },
      { id: 'te-IN-MohanNeural',    name: '🇮🇳 Mohan — Telugu Male',                lang: 'te-IN', gender: 'Male'   },
      // ── Kannada ───────────────────────────────────────────────
      { id: 'kn-IN-SapnaNeural',    name: '🇮🇳 Sapna — Kannada Female',             lang: 'kn-IN', gender: 'Female' },
      { id: 'kn-IN-GaganNeural',    name: '🇮🇳 Gagan — Kannada Male',               lang: 'kn-IN', gender: 'Male'   },
      // ── Malayalam ─────────────────────────────────────────────
      { id: 'ml-IN-SobhanaNeural',  name: '🇮🇳 Sobhana — Malayalam Female',         lang: 'ml-IN', gender: 'Female' },
      { id: 'ml-IN-MidhunNeural',   name: '🇮🇳 Midhun — Malayalam Male',            lang: 'ml-IN', gender: 'Male'   },
      // ── Marathi ───────────────────────────────────────────────
      { id: 'mr-IN-AarohiNeural',   name: '🇮🇳 Aarohi — Marathi Female',            lang: 'mr-IN', gender: 'Female' },
      { id: 'mr-IN-ManoharNeural',  name: '🇮🇳 Manohar — Marathi Male',             lang: 'mr-IN', gender: 'Male'   },
      // ── Gujarati ──────────────────────────────────────────────
      { id: 'gu-IN-DhwaniNeural',   name: '🇮🇳 Dhwani — Gujarati Female',           lang: 'gu-IN', gender: 'Female' },
      { id: 'gu-IN-NiranjanNeural', name: '🇮🇳 Niranjan — Gujarati Male',           lang: 'gu-IN', gender: 'Male'   },
      // ── Bengali ───────────────────────────────────────────────
      { id: 'bn-IN-TanishaaNeural', name: '🇮🇳 Tanishaa — Bengali Female',          lang: 'bn-IN', gender: 'Female' },
      { id: 'bn-IN-BashkarNeural',  name: '🇮🇳 Bashkar — Bengali Male',             lang: 'bn-IN', gender: 'Male'   },
      // ── Urdu ──────────────────────────────────────────────────
      { id: 'ur-IN-GulNeural',      name: '🇮🇳 Gul — Urdu Female',                  lang: 'ur-IN', gender: 'Female' },
      { id: 'ur-IN-SalmanNeural',   name: '🇮🇳 Salman — Urdu Male',                 lang: 'ur-IN', gender: 'Male'   },
      // ── Punjabi ───────────────────────────────────────────────
      { id: 'pa-IN-OjasNeural',     name: '🇮🇳 Ojas — Punjabi Male',                lang: 'pa-IN', gender: 'Male'   },
      // ── English - India ────────────────────────────────────────
      { id: 'en-IN-NeerjaNeural',   name: '🇮🇳 Neerja — Indian English Female',     lang: 'en-IN', gender: 'Female' },
      { id: 'en-IN-PrabhatNeural',  name: '🇮🇳 Prabhat — Indian English Male',      lang: 'en-IN', gender: 'Male'   },
      // ── English - US ───────────────────────────────────────────
      { id: 'en-US-JennyNeural',    name: '🇺🇸 Jenny — US English Female',          lang: 'en-US', gender: 'Female' },
      { id: 'en-US-GuyNeural',      name: '🇺🇸 Guy — US English Male',              lang: 'en-US', gender: 'Male'   },
      { id: 'en-US-AriaNeural',     name: '🇺🇸 Aria — US English Female',           lang: 'en-US', gender: 'Female' },
      { id: 'en-US-DavisNeural',    name: '🇺🇸 Davis — US English Male',            lang: 'en-US', gender: 'Male'   },
      // ── English - UK ───────────────────────────────────────────
      { id: 'en-GB-SoniaNeural',    name: '🇬🇧 Sonia — UK English Female',          lang: 'en-GB', gender: 'Female' },
      { id: 'en-GB-RyanNeural',     name: '🇬🇧 Ryan — UK English Male',             lang: 'en-GB', gender: 'Male'   },
      // ── Spanish ────────────────────────────────────────────────
      { id: 'es-ES-ElviraNeural',   name: '🇪🇸 Elvira — Spanish Female',            lang: 'es-ES', gender: 'Female' },
    ];
  }
}

module.exports = new TtsService();
