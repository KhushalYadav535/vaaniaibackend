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

  _key(text, voiceId, speed, provider) {
    return crypto.createHash('md5').update(`${provider}:${voiceId}:${speed}:${text}`).digest('hex');
  }

  get(text, voiceId, speed, provider) {
    const key = this._key(text, voiceId, speed, provider);
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

  set(text, voiceId, speed, provider, buffer) {
    if (!buffer || buffer.length === 0) return;
    const key = this._key(text, voiceId, speed, provider);

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
  async textToSpeech({ text, voiceId = 'en-US-JennyNeural', speed = 1.0, pitch = 0, apiKey = null, provider = 'edge-tts' }) {
    if (!text || text.trim().length === 0) return Buffer.alloc(0);

    // ── Check cache first ─────────────────────────────────────────────
    if (this._cacheEnabled) {
      const cached = this.cache.get(text, voiceId, speed, provider);
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
    }

    // Default to Edge TTS (Free)
    if (!audioBuffer) {
      // Try pooled connection first — saves ~80-150ms WS handshake per call.
      // Falls through to a fresh WS (in-memory then file) if the pool errors.
      if (USE_TTS_POOL) {
        try {
          audioBuffer = await edgeTtsPool.synthesize({ text, voiceId, speed, pitch });
        } catch (e) {
          console.error('Edge TTS pool failed, falling back to fresh WS:', e.message);
        }
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        try {
          audioBuffer = await this.edgeTTSInMemory(text, voiceId, speed, pitch);
        } catch (e) {
          console.error('Edge TTS in-memory failed, trying file fallback:', e.message);
          audioBuffer = await this.edgeTTSFileFallback(text, voiceId, speed, pitch);
        }
      }
    }

    // ── Store in cache ────────────────────────────────────────────────
    if (this._cacheEnabled && audioBuffer && audioBuffer.length > 0) {
      this.cache.set(text, voiceId, speed, provider, audioBuffer);
    }

    return audioBuffer || Buffer.alloc(0);
  }

  async edgeTTSInMemory(text, voiceId, speed, pitch) {
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
        reject(err);
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
      _wsConnect.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n` + 
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${langCode}">` +
        `<voice name="${voiceId}">` +
        `<prosody rate="${rate}" pitch="${pitchStr}" volume="default">` +
        `${escapeXml(text)}` +
        `</prosody></voice></speak>`
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
      console.error('Edge TTS file fallback error:', e.message);
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
   * ElevenLabs TTS Implementation
   * Turbo v2.5 is extremely fast
   */
  async elevenLabsTTS(text, voiceId, apiKey) {
    // If voiceId is an Edge voice, use a default ElevenLabs voice
    const elVoiceId = voiceId.includes('Neural') ? '21m00Tcm4TlvDq8ikWAM' : voiceId;
    
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${elVoiceId}/stream`, {
      method: 'POST',
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail?.message || 'ElevenLabs API error');
    }

    return await response.buffer();
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
