/**
 * Deepgram STT Service
 * Uses raw WebSocket (ws library) instead of @deepgram/sdk
 * because the SDK's internal WS implementation fails on this environment
 * while the raw ws library connects successfully.
 */
const WebSocket = require('ws');

class DeepgramService {
  constructor() {
    this._latencyConfigLogged = false;
  }

  /**
   * Transcribe audio buffer (one-shot, for recorded audio)
   */
  async transcribeAudio({ audioBuffer, apiKey, language = 'en', mimeType = 'audio/webm' }) {
    const key = apiKey || process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('No Deepgram API key configured.');

    const fetch = require('node-fetch');
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=' + language + '&smart_format=true&punctuate=true', {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + key,
        'Content-Type': mimeType,
      },
      body: audioBuffer,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Deepgram prerecorded error ${res.status}: ${errText}`);
    }

    const result = await res.json();
    const transcript = result?.results?.channels[0]?.alternatives[0]?.transcript || '';
    const confidence = result?.results?.channels[0]?.alternatives[0]?.confidence || 0;
    return { transcript, confidence };
  }

  /**
   * Create a live streaming transcription WebSocket connection
   * Returns an object compatible with the old Deepgram LiveClient API:
   *   .send(buffer)   — send audio data
   *   .finish()       — close the connection gracefully
   */
  createLiveConnection({ apiKey, language = 'en', backgroundDenoising = 'default', onTranscript, onError, onClose }) {
    const key = apiKey || process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('No Deepgram API key. Get $200 free credits at https://deepgram.com');

    const model = process.env.DEEPGRAM_MODEL || 'nova-2';

    // Map Hinglish to standard Hindi model
    let sttLanguage = language;
    if (sttLanguage === 'hi-Latn') sttLanguage = 'hi';

    // Language selection for STT:
    // For Hindi agents, use 'multi' NOT 'hi' — reason:
    //   - 'hi' mode fails 100% on English words (website→sach, banana→main)
    //   - 'multi' handles Hinglish (Hindi+English code-switching) — occasional
    //     Spanish confusion is less harmful than total English word loss
    // 'en' agents keep 'en' | explicitly set agents keep their value
    if (sttLanguage === 'hi') sttLanguage = 'multi';
    const forceMulti = process.env.DEEPGRAM_FORCE_MULTI === 'explicit';
    if (forceMulti) sttLanguage = 'multi';

    const fastTurnMode = String(process.env.FAST_TURN_MODE || 'false').toLowerCase() === 'true';
    const defaultUtteranceEndMs = fastTurnMode ? 650 : 1200;
    const defaultEndpointingMs  = fastTurnMode ? 250 : 400;
    const utteranceEndMs = Number(process.env.DEEPGRAM_UTTERANCE_END_MS || defaultUtteranceEndMs);
    const endpointingMs  = Number(process.env.DEEPGRAM_ENDPOINTING_MS  || defaultEndpointingMs);
    const minFinalChars  = Number(process.env.MIN_TRANSCRIPT_CHARS_FOR_FINAL || 2);
    const audioInputMode = (process.env.DEEPGRAM_AUDIO_INPUT_MODE || 'webm').toLowerCase();
    const encoding   = process.env.DEEPGRAM_ENCODING    || 'linear16';
    const sampleRate = Number(process.env.DEEPGRAM_SAMPLE_RATE || 16000);
    const channels   = Number(process.env.DEEPGRAM_CHANNELS   || 1);
    const mimeType   = process.env.DEEPGRAM_MIME_TYPE || 'audio/webm;codecs=opus';

    if (!this._latencyConfigLogged) {
      console.log(`[Deepgram Latency Config] FAST_TURN_MODE=${fastTurnMode} utterance_end_ms=${utteranceEndMs} endpointing=${endpointingMs} min_final_chars=${minFinalChars}`);
      console.log(`[Deepgram STT Config] model=${model} language=${sttLanguage} force_multi=${forceMulti}`);
      if (audioInputMode === 'webm') {
        console.log(`[Deepgram Audio Config] mode=webm mimetype=${mimeType}`);
      } else {
        console.log(`[Deepgram Audio Config] mode=raw encoding=${encoding} sample_rate=${sampleRate} channels=${channels}`);
      }
      this._latencyConfigLogged = true;
    }

    // Build query string
    const params = new URLSearchParams({
      model,
      language: sttLanguage,
      smart_format: 'true',
      interim_results: 'true',
      endpointing: String(endpointingMs),
    });

    if (audioInputMode === 'webm') {
      // webm mode: use opus params that Deepgram accepts for webm streams
      params.set('encoding', 'opus');
      params.set('sample_rate', '48000');
      params.set('channels', '1');
    } else {
      // raw mode: use specified encoding
      params.set('encoding', encoding);
      params.set('sample_rate', String(sampleRate));
      params.set('channels', String(channels));
    }

    if (backgroundDenoising === 'high') {
      params.set('diarize', 'true');
      params.set('filler_words', 'true');
    }

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    const ws = new WebSocket(url, {
      headers: { Authorization: 'Token ' + key },
    });

    ws.on('open', () => {
      console.log('🎙️ Deepgram connection opened');
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle UtteranceEnd
        if (msg.type === 'UtteranceEnd') {
          return;
        }

        if (msg.type !== 'Results') return;

        const transcript = msg.channel?.alternatives?.[0]?.transcript;
        const isFinal    = msg.is_final === true;
        const speechFinal = msg.speech_final === true;

        if (transcript && onTranscript) {
          const trimmed = transcript.trim();
          if (isFinal && speechFinal && trimmed.length < minFinalChars) return;
          onTranscript({ transcript, isFinal, speechFinal });
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on('error', (err) => {
      const normalized = {
        message: err?.message || 'WebSocket connection failed',
        code: err?.code || 'network_error',
        type: 'error',
        raw: err,
      };
      console.error('🔴 Deepgram error:', err?.message || err);
      if (err?.message?.includes('network') || err?.message?.includes('101')) {
        console.error('🔴 Deepgram network error - possible API key or connectivity issue');
      }
      if (onError) onError(normalized);
    });

    ws.on('close', (code, reason) => {
      const closeInfo = {
        code,
        reason: reason ? reason.toString() : '',
        wasClean: code === 1000,
      };
      console.log(`🔵 Deepgram connection closed: code=${code}`);
      if (onClose) onClose(closeInfo);
    });

    // Return a compatible wrapper object
    return {
      send(buffer) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buffer);
        }
      },
      finish() {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, 'Session ended');
          }
        } catch (e) {
          // ignore
        }
      },
      // Expose readyState for external checks
      get readyState() {
        return ws.readyState;
      },
    };
  }
}

module.exports = new DeepgramService();
