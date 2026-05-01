const express = require('express');
const router = express.Router();
const Agent = require('../models/Agent');
const { protect } = require('../middleware/auth');

// All routes require auth
router.use(protect);

// @route   GET /api/agents
router.get('/', async (req, res, next) => {
  try {
    const { status, search, sortBy = 'createdAt', order = 'desc' } = req.query;
    const query = { userId: req.user._id };

    if (status && status !== 'all') query.status = status;
    if (search) query.name = { $regex: search, $options: 'i' };

    const sort = { [sortBy]: order === 'asc' ? 1 : -1 };
    const agents = await Agent.find(query).sort(sort);

    res.json({ success: true, count: agents.length, agents });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/agents/:id
router.get('/:id', async (req, res, next) => {
  try {
    const agent = await Agent.findOne({ _id: req.params.id, userId: req.user._id });
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
    res.json({ success: true, agent });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/agents
router.post('/', async (req, res, next) => {
  try {
    const { name, systemPrompt, firstMessage, language, voice, llm, temperature, maxDuration, endCallMessage, endCallPhrases, webhooks, tools, voicemailMessage, transferNumber, transferToAgentId, transferConditions, postCallActions, advanced, knowledgeBaseId, workflowId } = req.body;

    const agent = await Agent.create({
      userId: req.user._id,
      name,
      systemPrompt,
      firstMessage,
      language: language || 'en',
      voice: voice || { provider: 'edge-tts', voiceId: 'en-US-JennyNeural' },
      llm: llm || { provider: 'groq', model: 'llama-3.1-8b-instant' },
      temperature: temperature || 0.7,
      maxDuration: maxDuration || 600,
      endCallMessage,
      endCallPhrases,
      webhooks,
      tools,
      voicemailMessage: voicemailMessage || '',
      transferNumber: transferNumber || '',
      transferToAgentId: transferToAgentId || undefined,
      transferConditions: transferConditions || {},
      postCallActions: postCallActions || {},
      advanced: advanced || {},
      knowledgeBaseId: knowledgeBaseId || undefined,
      workflowId: workflowId || undefined,
    });

    res.status(201).json({ success: true, agent });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/agents/:id
router.put('/:id', async (req, res, next) => {
  try {
    const agent = await Agent.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
    res.json({ success: true, agent });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/agents/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const agent = await Agent.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
    res.json({ success: true, message: 'Agent deleted' });
  } catch (error) {
    next(error);
  }
});

// @route   PATCH /api/agents/:id/status
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    const agent = await Agent.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { status },
      { new: true }
    );
    if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
    res.json({ success: true, agent });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/agents/:id/duplicate
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const original = await Agent.findOne({ _id: req.params.id, userId: req.user._id });
    if (!original) return res.status(404).json({ success: false, message: 'Agent not found' });

    const { _id, createdAt, updatedAt, callsCount, totalMinutes, ...rest } = original.toObject();

    const duplicate = await Agent.create({
      ...rest,
      userId: req.user._id,
      name: `Copy of ${original.name}`,
      status: 'inactive',
      callsCount: 0,
      totalMinutes: 0,
    });

    res.status(201).json({ success: true, agent: duplicate });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
