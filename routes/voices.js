/**
 * Voices Route — GET /api/voices
 * Returns available voices grouped by provider.
 * ElevenLabs voices are fetched live from the API.
 * Edge TTS voices are returned from a curated static list (no API call needed).
 * Cartesia voices are fetched live if a key is set.
 */
const express = require('express');
const router  = express.Router();
const fetch   = require('node-fetch');
const { protect } = require('../middleware/auth');

// ── Edge TTS curated voice list (free, no key) ───────────────────────────────
const EDGE_TTS_VOICES = [
  // Hindi
  { voiceId: 'hi-IN-SwaraNeural',   name: 'Swara (Hindi - Female)',   lang: 'hi-IN',  gender: 'Female' },
  { voiceId: 'hi-IN-MadhurNeural',  name: 'Madhur (Hindi - Male)',    lang: 'hi-IN',  gender: 'Male'   },
  // English India
  { voiceId: 'en-IN-NeerjaNeural',  name: 'Neerja (English India - Female)', lang: 'en-IN', gender: 'Female' },
  { voiceId: 'en-IN-PrabhatNeural', name: 'Prabhat (English India - Male)',   lang: 'en-IN', gender: 'Male'   },
  // English US
  { voiceId: 'en-US-JennyNeural',   name: 'Jenny (English US - Female)',      lang: 'en-US', gender: 'Female' },
  { voiceId: 'en-US-GuyNeural',     name: 'Guy (English US - Male)',          lang: 'en-US', gender: 'Male'   },
  { voiceId: 'en-US-AriaNeural',    name: 'Aria (English US - Female)',       lang: 'en-US', gender: 'Female' },
  { voiceId: 'en-US-DavisNeural',   name: 'Davis (English US - Male)',        lang: 'en-US', gender: 'Male'   },
  { voiceId: 'en-US-AmberNeural',   name: 'Amber (English US - Female)',      lang: 'en-US', gender: 'Female' },
  { voiceId: 'en-US-AnaNeural',     name: 'Ana (English US - Female)',        lang: 'en-US', gender: 'Female' },
  // English UK
  { voiceId: 'en-GB-SoniaNeural',   name: 'Sonia (English UK - Female)', lang: 'en-GB', gender: 'Female' },
  { voiceId: 'en-GB-RyanNeural',    name: 'Ryan (English UK - Male)',    lang: 'en-GB', gender: 'Male'   },
  { voiceId: 'en-GB-LibbyNeural',   name: 'Libby (English UK - Female)', lang: 'en-GB', gender: 'Female' },
  // Tamil
  { voiceId: 'ta-IN-PallaviNeural', name: 'Pallavi (Tamil - Female)', lang: 'ta-IN', gender: 'Female' },
  { voiceId: 'ta-IN-ValluvarNeural', name: 'Valluvar (Tamil - Male)', lang: 'ta-IN', gender: 'Male'   },
  // Telugu
  { voiceId: 'te-IN-ShrutiNeural',  name: 'Shruti (Telugu - Female)', lang: 'te-IN', gender: 'Female' },
  { voiceId: 'te-IN-MohanNeural',   name: 'Mohan (Telugu - Male)',    lang: 'te-IN', gender: 'Male'   },
  // Marathi
  { voiceId: 'mr-IN-AarohiNeural',  name: 'Aarohi (Marathi - Female)', lang: 'mr-IN', gender: 'Female' },
  { voiceId: 'mr-IN-ManoharNeural', name: 'Manohar (Marathi - Male)',   lang: 'mr-IN', gender: 'Male'   },
  // Bengali
  { voiceId: 'bn-IN-TanishaaNeural', name: 'Tanishaa (Bengali - Female)', lang: 'bn-IN', gender: 'Female' },
  { voiceId: 'bn-IN-BashkarNeural',  name: 'Bashkar (Bengali - Male)',    lang: 'bn-IN', gender: 'Male'   },
  // Gujarati
  { voiceId: 'gu-IN-DhwaniNeural',  name: 'Dhwani (Gujarati - Female)', lang: 'gu-IN', gender: 'Female' },
  { voiceId: 'gu-IN-NiranjanNeural', name: 'Niranjan (Gujarati - Male)', lang: 'gu-IN', gender: 'Male'   },
];

// ── ElevenLabs voice fetch ────────────────────────────────────────────────────
async function fetchElevenLabsVoices(apiKey) {
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey },
      timeout: 8000,
    });
    if (!res.ok) throw new Error(`ElevenLabs API ${res.status}`);
    const data = await res.json();
    return (data.voices || []).map(v => ({
      voiceId:  v.voice_id,
      name:     v.name,
      lang:     v.labels?.language || 'multi',
      gender:   v.labels?.gender   || 'Unknown',
      accent:   v.labels?.accent   || '',
      age:      v.labels?.age      || '',
      preview:  v.preview_url      || null,
    }));
  } catch (err) {
    console.warn('[Voices] ElevenLabs fetch failed:', err.message);
    return [];
  }
}

// ── Cartesia voice fetch ──────────────────────────────────────────────────────
async function fetchCartesiaVoices(apiKey) {
  try {
    const res = await fetch('https://api.cartesia.ai/voices', {
      headers: {
        'X-API-Key':  apiKey,
        'Cartesia-Version': '2024-06-10',
      },
      timeout: 8000,
    });
    if (!res.ok) throw new Error(`Cartesia API ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.voices || []);
    return list.map(v => ({
      voiceId: v.id,
      name:    v.name,
      lang:    v.language || 'en',
      gender:  v.gender   || 'Unknown',
    }));
  } catch (err) {
    console.warn('[Voices] Cartesia fetch failed:', err.message);
    return [];
  }
}

// ── GET /api/voices ────────────────────────────────────────────────────────────
// Returns { providers: [{ id, name, voices: [] }] }
router.get('/', protect, async (req, res, next) => {
  try {
    const results = [];

    // 1. Edge TTS — always available
    results.push({
      id:     'edge-tts',
      name:   'Edge TTS (Free)',
      voices: EDGE_TTS_VOICES,
    });

    // 2. ElevenLabs — if key is set
    const elKey = process.env.ELEVENLABS_API_KEY;
    if (elKey) {
      const voices = await fetchElevenLabsVoices(elKey);
      results.push({
        id:     'eleven-labs',
        name:   'ElevenLabs',
        voices,
      });
    }

    // 3. Cartesia — if key is set
    const cartesiaKey = process.env.CARTESIA_API_KEY;
    if (cartesiaKey) {
      const voices = await fetchCartesiaVoices(cartesiaKey);
      results.push({
        id:     'cartesia',
        name:   'Cartesia',
        voices,
      });
    }

    res.json({ success: true, providers: results });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
