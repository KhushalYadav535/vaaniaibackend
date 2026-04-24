/**
 * Voice Preview Route
 * Returns MP3 audio of text-to-speech for a given voice
 * Used by the Voice Settings page to preview voices
 */
const express = require('express');
const router = express.Router();
const ttsService = require('../services/ttsService');
const { protect } = require('../middleware/auth');

// POST /api/voice-preview
// { text, voiceId, speed }
router.post('/', protect, async (req, res, next) => {
  try {
    let { text, voiceId, speed } = req.body;

    if (!text) text = 'Hello! I am your AI assistant powered by VaaniAI. How can I help you today?';
    if (!voiceId) voiceId = 'en-US-JennyNeural';
    if (!speed) speed = 1.0;

    // Limit preview text length
    if (text.length > 300) text = text.slice(0, 300) + '...';

    const audioBuffer = await ttsService.textToSpeech({ text, voiceId, speed: parseFloat(speed) });

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(500).json({ success: false, message: 'TTS generation failed. Make sure node-edge-tts is installed.' });
    }

    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'no-cache',
    });
    res.send(audioBuffer);
  } catch (error) {
    console.error('Voice preview error:', error.message);
    next(error);
  }
});

module.exports = router;
