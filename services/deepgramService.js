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
    // numerals (not smart_format) so phone numbers/OTPs stay as plain digit
    // runs instead of being reformatted into 09:05-style times.
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=' + language + '&numerals=true&punctuate=true', {
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
    // Default to nova-2: nova-3 does NOT support the `keywords` parameter — it
    // returns HTTP 400 for any request that includes `keywords=...`. Since we
    // always send keyword boosting terms, nova-2 is the correct model to use.
    // nova-3 can be opted-in via DEEPGRAM_MODEL=nova-3 ONLY when you also set
    // DEEPGRAM_DISABLE_KEYWORDS=true (so no `keywords`/`keyterm` are sent).
    const model = process.env.DEEPGRAM_MODEL || 'nova-2';

    let sttLanguage = language;
    if (sttLanguage === 'hi-Latn') sttLanguage = 'hi';

    // nova-3 requires `keyterm` (repeated params) instead of `keywords` (comma-separated).
    // If the model is nova-3 and we have keywords, we either:
    //   a) Switch to nova-2 (safe, recommended), OR
    //   b) Use keyterm format (if DEEPGRAM_USE_KEYTERM=true is set)
    // For hi/multi, always fall back to nova-2 regardless.
    let finalModel = model;
    const hasKeywords = keywords && keywords.length > 0;
    const useKeyterm = String(process.env.DEEPGRAM_USE_KEYTERM || 'false').toLowerCase() === 'true';
    if (finalModel === 'nova-3') {
      if (sttLanguage === 'hi' || sttLanguage === 'multi' ||
          process.env.DEEPGRAM_FORCE_MULTI === 'true' ||
          process.env.DEEPGRAM_FORCE_MULTI === 'explicit') {
        // nova-3 doesn't support hi/multi reliably — use nova-2
        finalModel = 'nova-2';
      } else if (hasKeywords && !useKeyterm) {
        // nova-3 + keywords param = 400 error. Fall back to nova-2 unless
        // operator has explicitly opted in to keyterm format.
        finalModel = 'nova-2';
        console.log('[Deepgram] Downgraded nova-3 -> nova-2 because keywords param is not supported by nova-3 (set DEEPGRAM_USE_KEYTERM=true to use keyterm format instead)');
      }
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
    // paused to recall a name or word.
    // voiceSession's commitTranscript adds a soft-commit window on top
    // of this for an extra safety net.
    const defaultEndpointingMs  = fastTurnMode ? 200 : 600;
    const endpointingMs  = Number(process.env.DEEPGRAM_ENDPOINTING_MS  || defaultEndpointingMs);

    // utterance_end_ms: Deepgram enforces a hard MINIMUM of 1000ms.
    // Sending any value below 1000 causes an HTTP 400 on the WebSocket
    // upgrade (the connection is rejected before any audio is sent).
    // Root cause of the 400 errors seen in production:
    //   FAST_TURN_MODE=true set utterance_end_ms=400 (below minimum).
    //
    // Deepgram docs: "UtteranceEnd relies on word timings from interim
    // results, which are generated ~once per second. Values < 1000ms
    // are unsupported."
    //
    // For fast turn detection, use `endpointing` (VAD-based, supports
    // values as low as 10ms) — NOT utterance_end_ms.
    //
    // We configure utterance_end_ms as a SAFETY NET that fires AFTER
    // speech_final already committed. So 1500ms is a reasonable default
    // that catches stalled speech_final events without being too aggressive.
    const rawUtteranceEndMs = Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 1500);
    const DEEPGRAM_UTTERANCE_END_MIN = 1000; // Hard minimum enforced by Deepgram API
    const utteranceEndMs = Math.max(DEEPGRAM_UTTERANCE_END_MIN, rawUtteranceEndMs);
    if (rawUtteranceEndMs < DEEPGRAM_UTTERANCE_END_MIN) {
      console.warn(`[Deepgram] ⚠️ utterance_end_ms=${rawUtteranceEndMs} is below Deepgram's minimum of ${DEEPGRAM_UTTERANCE_END_MIN}ms — clamped to ${utteranceEndMs}ms. For faster turn detection use endpointing (currently ${endpointingMs}ms).`);
    }

    // Default raised from 2→3: single 2-char noise words ("मन", "हाँ", "mm")
    // that Deepgram hallucinates as speech_final are now blocked at source.
    // Override via MIN_TRANSCRIPT_CHARS_FOR_FINAL env var if needed.
    const minFinalChars  = Number(process.env.MIN_TRANSCRIPT_CHARS_FOR_FINAL || 3);

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
    // ── Number formatting strategy ──────────────────────────────────────
    // smart_format is great for general readability BUT it formats spoken
    // digit sequences as TIMES/DATES — e.g. a phone number "zero nine zero
    // five..." becomes "09:05", which then corrupts phone/OTP capture and
    // breaks CRM lead creation. `numerals=true` converts number words to
    // digits WITHOUT the date/time smart formatting. For a phone-capturing
    // voice agent, numerals (+ punctuate) is the safer default.
    // Tunable via env if a deployment prefers full smart_format.
    const smartFormat = String(process.env.DEEPGRAM_SMART_FORMAT || 'false').toLowerCase() === 'true';
    const useNumerals = String(process.env.DEEPGRAM_NUMERALS || 'true').toLowerCase() === 'true';

    const params = new URLSearchParams({
      model: finalModel,
      language: sttLanguage,
      interim_results: 'true',
      endpointing: String(endpointingMs),
      // FIX Bug #4: utterance_end_ms was computed and logged but never added to
      // the query string — so Deepgram never activated UtteranceEnd events.
      // Without this, turn-taking relied solely on speech_final with no safety net.
      utterance_end_ms: String(utteranceEndMs),
    });
    if (smartFormat) {
      params.set('smart_format', 'true');
    } else {
      // Keep readable punctuation, convert number-words to digits, but DON'T
      // let Deepgram reformat digit runs into 09:05-style times/dates.
      params.set('punctuate', 'true');
      if (useNumerals) params.set('numerals', 'true');
    }

    if (audioInputMode !== 'webm') {
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
    // IMPORTANT: nova-2 uses `keywords` (comma-separated, supports :weight intensifiers)
    //            nova-3 uses `keyterm` (repeated URL params, NO weights supported)
    if (keywords && keywords.length > 0) {
      const validKeywords = keywords.filter(k => typeof k === 'string' && k.trim().length > 0).slice(0, 100);
      if (validKeywords.length > 0) {
        if (finalModel === 'nova-3') {
          // nova-3: use `keyterm` repeated params (no comma-joining, no weights)
          // URLSearchParams.set() overwrites, so we must use .append() for repeated params
          // Strip any legacy :weight suffixes (e.g. "term:0.5" -> "term")
          const cleanTerms = validKeywords.map(k => k.replace(/:[0-9.]+$/, '').trim());
          // Build the URL manually for repeated keyterm params since URLSearchParams
          // doesn't support duplicate keys well across all Node versions.
          cleanTerms.forEach(term => params.append('keyterm', term));
          console.log(`[Deepgram] Keyterm boosting (nova-3): ${cleanTerms.length} terms`);
        } else {
          // nova-2 and older: standard comma-separated keywords
          params.set('keywords', validKeywords.join(','));
          console.log(`[Deepgram] Keyword boosting: ${validKeywords.length} terms`);
        }
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

        // Handle UtteranceEnd — fires when Deepgram decides the utterance is done
        // (after utterance_end_ms of silence post-speech_final). This is the
        // FIX Bug #4 companion: the param is now sent, so the event will fire.
        // Forward to onVADEvent so voiceSession can use it as a turn-taking
        // safety net (e.g. flush soft-commit if still pending after speech_final).
        if (msg.type === 'UtteranceEnd') {
          if (onVADEvent) onVADEvent({ type: 'utterance_end', lastWordEnd: msg.last_word_end });
          return;
        }

        // Handle SpeechStarted VAD event
        if (msg.type === 'SpeechStarted') {
          if (onVADEvent) onVADEvent({ type: 'speech_started', timestamp: msg.timestamp });
          return;
        }

        if (msg.type !== 'Results') return;

        const alt = msg.channel?.alternatives?.[0];
        const transcript = alt?.transcript;
        const isFinal = msg.is_final === true;
        const speechFinal = msg.speech_final === true;
        const fromFinalize = msg.from_finalize === true;
        const start = typeof msg.start === 'number' ? msg.start : null;
        const duration = typeof msg.duration === 'number' ? msg.duration : null;
        const confidence = typeof alt?.confidence === 'number' ? alt.confidence : null;

        console.log('[Deepgram] Results', JSON.stringify({
          transcript: (transcript || '').slice(0, 120),
          is_final: isFinal,
          speech_final: speechFinal,
          from_finalize: fromFinalize,
          start,
          duration,
          confidence,
        }));

        if (transcript && onTranscript) {
          const trimmed = transcript.trim();
          if (isFinal && speechFinal && trimmed.length < minFinalChars) {
            console.log(`[Deepgram] Dropped short speech_final (${trimmed.length} chars < min ${minFinalChars}): "${trimmed}"`);
            return;
          }
          onTranscript({
            transcript,
            isFinal,
            speechFinal,
            fromFinalize,
            start,
            duration,
            confidence,
          });
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
