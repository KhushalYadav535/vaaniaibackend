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
   * Create a live streaming transcription WebSocket connection.
   * Returns an object compatible with the old Deepgram LiveClient API:
   *   .send(buffer)   — send audio data
   *   .finish()       — close the connection gracefully
   *
   * @param audioConfig  Optional explicit audio config { encoding, sampleRate, channels, audioInputMode }.
   *                     Overrides env vars. Use this for per-session config to avoid
   *                     the race condition caused by mutating process.env in concurrent sessions.
   */
  createLiveConnection({ apiKey, language = 'en', backgroundDenoising = 'default', onTranscript, onError, onClose, keywords = [], onVADEvent = null, audioConfig = null }) {
    const key = apiKey || process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('No Deepgram API key. Get $200 free credits at https://deepgram.com');
    // Using nova-2 as nova-3 may return 400 for certain languages like hi/multi
    const model = process.env.DEEPGRAM_MODEL || 'nova-2';

    let sttLanguage = language;
    if (sttLanguage === 'hi-Latn') sttLanguage = 'hi';

    // Force nova-2 for multi/hi as nova-3 is returning 400 errors for these languages
    let finalModel = model;
    if (finalModel === 'nova-3' && (sttLanguage === 'hi' || sttLanguage === 'multi' || process.env.DEEPGRAM_FORCE_MULTI === 'true' || process.env.DEEPGRAM_FORCE_MULTI === 'explicit')) {
      finalModel = 'nova-2';
    }

    // Language selection for STT:
    // Let the agent's language dictate the model.
    // 'nova-2' with 'hi' supports Hindi script and Hinglish nouns.
    const forceMulti = process.env.DEEPGRAM_FORCE_MULTI === 'explicit';
    if (forceMulti) sttLanguage = 'multi';

    const fastTurnMode = String(process.env.FAST_TURN_MODE || 'false').toLowerCase() === 'true';
    // Endpointing patience (how long Deepgram waits before declaring
    // end-of-utterance). Bumped from 1200/400 → 1600/600 because the
    // smaller window was firing speech_final mid-thought when users
    // paused to recall a name or word ("मुझे school के लिए... [pause]
    // ...इसमें... [pause] ...MDS Vidyapeeth"). voiceSession's
    // commitTranscript adds a soft-commit window on top of this for an
    // extra safety net.
    const defaultUtteranceEndMs = fastTurnMode ? 400 : 1600;
    const defaultEndpointingMs  = fastTurnMode ? 200 : 600;
    const utteranceEndMs = Number(process.env.DEEPGRAM_UTTERANCE_END_MS || defaultUtteranceEndMs);
    const endpointingMs  = Number(process.env.DEEPGRAM_ENDPOINTING_MS  || defaultEndpointingMs);
    const minFinalChars  = Number(process.env.MIN_TRANSCRIPT_CHARS_FOR_FINAL || 2);

    // FIX: Use explicit audioConfig (per-session) if provided, otherwise fall back to env vars.
    // This avoids the dangerous pattern of mutating process.env for per-session audio config,
    // which creates a race condition when two sessions trigger mic_config simultaneously.
    const audioInputMode = audioConfig?.audioInputMode || (process.env.DEEPGRAM_AUDIO_INPUT_MODE || 'webm').toLowerCase();
    const encoding   = audioConfig?.encoding    || process.env.DEEPGRAM_ENCODING    || 'linear16';
    const sampleRate = Number(audioConfig?.sampleRate || process.env.DEEPGRAM_SAMPLE_RATE || 16000);
    const channels   = Number(audioConfig?.channels   || process.env.DEEPGRAM_CHANNELS   || 1);
    const mimeType   = audioConfig?.mimeType || process.env.DEEPGRAM_MIME_TYPE || 'audio/webm;codecs=opus';

    if (!this._latencyConfigLogged) {
      console.log(`[Deepgram Latency Config] FAST_TURN_MODE=${fastTurnMode} utterance_end_ms=${utteranceEndMs} endpointing=${endpointingMs} min_final_chars=${minFinalChars}`);
      console.log(`[Deepgram STT Config] model=${finalModel} language=${sttLanguage} force_multi=${forceMulti}`);
      if (audioInputMode === 'webm') {
        console.log(`[Deepgram Audio Config] mode=webm mimetype=${mimeType}`);
      } else {
        console.log(`[Deepgram Audio Config] mode=raw encoding=${encoding} sample_rate=${sampleRate} channels=${channels}`);
      }
      this._latencyConfigLogged = true;
    }

    // Build query string
    const params = new URLSearchParams({
      model: finalModel,
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

    // Keyword boosting: improves recognition of domain-specific terms
    // (company names, product names, agent-specific vocabulary)
    if (keywords && keywords.length > 0) {
      const validKeywords = keywords.filter(k => typeof k === 'string' && k.trim().length > 0).slice(0, 100);
      if (validKeywords.length > 0) {
        params.set('keywords', validKeywords.join(','));
        console.log(`[Deepgram] Keyword boosting: ${validKeywords.length} terms`);
      }
    }

    // Enable VAD events for smarter turn-taking
    params.set('vad_events', 'true');

    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    const ws = new WebSocket(url, {
      headers: { Authorization: 'Token ' + key },
    });

    // FIX: Keepalive ping every 10s to prevent Deepgram idle-timeout disconnects.
    // Without this, the WS connection silently drops after ~60s of silence
    // (e.g. user on hold, long pauses). Deepgram accepts a JSON { type: 'KeepAlive' }
    // message to reset the server-side idle timer without sending audio data.
    let keepaliveInterval = null;

    ws.on('open', () => {
      console.log('🎙️ Deepgram connection opened');
      keepaliveInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'KeepAlive' }));
          } catch (_) { /* ignore if connection is closing */ }
        }
      }, 10000);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle UtteranceEnd
        if (msg.type === 'UtteranceEnd') {
          return;
        }

        // Handle SpeechStarted VAD event
        if (msg.type === 'SpeechStarted') {
          if (onVADEvent) onVADEvent({ type: 'speech_started', timestamp: msg.timestamp });
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
      if (err?.message === 'WebSocket was closed before the connection was established') {
        console.log('🔵 Deepgram connection closed before established (likely reinitialized).');
        return;
      }
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
      // Clean up keepalive interval on close
      if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
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
          if (keepaliveInterval) { clearInterval(keepaliveInterval); keepaliveInterval = null; }
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            // Remove listeners to prevent 'error' or 'close' events from firing after we intentionally close it.
            // This is especially important for CONNECTING sockets which would emit an error.
            ws.removeAllListeners('error');
            ws.removeAllListeners('close');
            ws.removeAllListeners('message');
            ws.removeAllListeners('open');
            ws.on('error', () => {}); // Catch any subsequent errors silently
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
