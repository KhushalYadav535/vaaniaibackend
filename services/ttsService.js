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

class TtsService {
  /**
   * Convert text to speech audio buffer
   * Returns: Buffer containing MP3 audio
   */
  async textToSpeech({ text, voiceId = 'en-US-JennyNeural', speed = 1.0, pitch = 0, apiKey = null }) {
    // If apiKey is provided, it's likely an ElevenLabs key
    if (apiKey || process.env.ELEVENLABS_API_KEY) {
      try {
        return await this.elevenLabsTTS(text, voiceId, apiKey || process.env.ELEVENLABS_API_KEY);
      } catch (e) {
        console.error('ElevenLabs TTS failed, falling back to Edge:', e.message);
      }
    }

    // Default to Edge TTS (Free)
    try {
      const path = require('path');
      const fs = require('fs');
      const os = require('os');

      const rate = `${speed >= 1 ? '+' : ''}${Math.round((speed - 1) * 100)}%`;
      const pitchStr = `${pitch >= 0 ? '+' : ''}${pitch}Hz`;

      const tts = new EdgeTTS({
        voice: voiceId,
        rate,
        pitch: pitchStr,
      });

      const tmpFile = path.join(os.tmpdir(), `tts_${Date.now()}_${Math.floor(Math.random()*1000)}.mp3`);
      
      await tts.ttsPromise(text, tmpFile);
      const audio = fs.readFileSync(tmpFile);
      fs.unlinkSync(tmpFile);
      
      return audio;
    } catch (e) {
      console.error('Edge TTS error:', e.message);
      return Buffer.alloc(0);
    }
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
