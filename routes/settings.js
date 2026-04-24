const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { protect } = require('../middleware/auth');

router.use(protect);

// @route   GET /api/settings
router.get('/', async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({ success: true, settings: user.settings });
});

// @route   PUT /api/settings
router.put('/', async (req, res, next) => {
  try {
    const allowedKeys = [
      'groqKey', 'openaiKey', 'geminiKey', 'deepgramKey',
      'elevenLabsKey', 'twilioAccountSid', 'twilioAuthToken',
      'twilioPhoneNumber', 'twilioWhatsAppNumber', 'preferredLlm', 'preferredTts'
    ];

    const updates = {};
    allowedKeys.forEach(key => {
      if (req.body[key] !== undefined) {
        updates[`settings.${key}`] = req.body[key];
      }
    });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true }
    );

    res.json({ success: true, settings: user.settings, message: 'Settings updated successfully' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/settings/test-groq
router.post('/test-groq', protect, async (req, res) => {
  try {
    const { apiKey } = req.body;
    const key = apiKey || req.user.settings?.groqKey || process.env.GROQ_API_KEY;

    if (!key) return res.status(400).json({ success: false, message: 'No Groq API key provided' });

    const Groq = require('groq-sdk');
    const groq = new Groq({ apiKey: key });

    await groq.chat.completions.create({
      messages: [{ role: 'user', content: 'Say "OK" in one word.' }],
      model: 'llama-3.1-8b-instant',
      max_tokens: 5,
    });

    res.json({ success: true, message: 'Groq API key is valid ✅' });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Invalid Groq API key: ' + error.message });
  }
});

// @route   POST /api/settings/test-deepgram
router.post('/test-deepgram', protect, async (req, res) => {
  try {
    const { apiKey } = req.body;
    const key = apiKey || req.user.settings?.deepgramKey || process.env.DEEPGRAM_API_KEY;

    if (!key) return res.status(400).json({ success: false, message: 'No Deepgram API key provided' });

    const { createClient } = require('@deepgram/sdk');
    const deepgram = createClient(key);
    await deepgram.manage.getProjects();

    res.json({ success: true, message: 'Deepgram API key is valid ✅' });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Invalid Deepgram API key' });
  }
});

module.exports = router;
