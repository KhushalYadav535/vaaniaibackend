/**
 * Deepgram STT Service
 * Free: $200 credits on signup at https://deepgram.com
 * Uses WebSocket for real-time streaming transcription
 */
const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

class DeepgramService {
  constructor() {
    this.clients = new Map();
  }

  getClient(apiKey) {
    const key = apiKey || process.env.DEEPGRAM_API_KEY;
    if (!key) throw new Error('No Deepgram API key. Get $200 free credits at https://deepgram.com');

    if (!this.clients.has(key)) {
      this.clients.set(key, createClient(key));
    }
    return this.clients.get(key);
  }

  /**
   * Transcribe audio buffer (one-shot, for recorded audio)
   */
  async transcribeAudio({ audioBuffer, apiKey, language = 'en', mimeType = 'audio/webm' }) {
    const deepgram = this.getClient(apiKey);

    const { result, error } = await deepgram.listen.prerecorded.transcribeFile(
      audioBuffer,
      {
        model: 'nova-2',
        language,
        smart_format: true,
        punctuate: true,
      }
    );

    if (error) throw error;

    const transcript = result?.results?.channels[0]?.alternatives[0]?.transcript || '';
    const confidence = result?.results?.channels[0]?.alternatives[0]?.confidence || 0;

    return { transcript, confidence };
  }

  /**
   * Create a live streaming transcription WebSocket connection
   * Returns a Deepgram LiveClient that emits events
   */
  createLiveConnection({ apiKey, language = 'en', backgroundDenoising = 'default', onTranscript, onError }) {
    const deepgram = this.getClient(apiKey);

    // nova-2 supports Hindi (hi), English (en), and multilingual (multi)
    const model = language === 'multi' ? 'nova-2' : 'nova-2';
    
    // Map internal agent language codes to Deepgram STT recognized codes
    let sttLanguage = language;
    
    // Map Hinglish to standard Hindi model
    if (sttLanguage === 'hi-Latn') {
      sttLanguage = 'hi';
    }

    const config = {
      model,
      language: sttLanguage,
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1200,   // slightly longer for Hindi natural pauses
      endpointing: 400,
      keepAlive: true,
    };

    if (backgroundDenoising === 'high') {
      // High denoising: use advanced formatting and filler word removal
      config.diarize = true;
      config.filler_words = true; // tags filler words so we can ignore them if needed
    }

    const connection = deepgram.listen.live(config);

    connection.on(LiveTranscriptionEvents.Open, () => {
      console.log('🎙️ Deepgram connection opened');
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel?.alternatives[0]?.transcript;
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;

      if (transcript && onTranscript) {
        onTranscript({ transcript, isFinal, speechFinal });
      }
    });

    connection.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('🔴 Deepgram error:', err);
      if (onError) onError(err);
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      console.log('🔵 Deepgram connection closed');
    });

    return connection;
  }

  // For when Deepgram is not configured - use silence detection heuristic
  static createMockTranscriptionHandler(onTranscript) {
    let buffer = '';
    return {
      send: (audioChunk) => {
        // Mock: just return empty transcription
      },
      finish: () => {
        if (onTranscript && buffer) {
          onTranscript({ transcript: buffer, isFinal: true, speechFinal: true });
          buffer = '';
        }
      }
    };
  }
}

module.exports = new DeepgramService();
