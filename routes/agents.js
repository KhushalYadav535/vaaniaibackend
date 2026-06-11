const express = require('express');
const router = express.Router();
const Agent = require('../models/Agent');
const KnowledgeBase = require('../models/KnowledgeBase');
const CallFlow = require('../models/CallFlow');
const { protect } = require('../middleware/auth');

// All routes require auth
router.use(protect);

/**
 * Validate that any referenced resources (knowledge base, call flow, transfer
 * target agent) actually belong to the requesting user. Returns an error
 * message string if a reference is invalid, or null when everything is fine.
 */
async function validateAgentReferences(userId, body) {
  const { knowledgeBaseId, workflowId, transferToAgentId } = body;

  if (knowledgeBaseId) {
    const kb = await KnowledgeBase.findOne({ _id: knowledgeBaseId, userId }).select('_id');
    if (!kb) return 'Knowledge base not found';
  }
  if (workflowId) {
    const flow = await CallFlow.findOne({ _id: workflowId, userId }).select('_id');
    if (!flow) return 'Call flow not found';
  }
  if (transferToAgentId) {
    const target = await Agent.findOne({ _id: transferToAgentId, userId }).select('_id');
    if (!target) return 'Transfer target agent not found';
  }
  return null;
}

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

    const refError = await validateAgentReferences(req.user._id, req.body);
    if (refError) {
      return res.status(404).json({ success: false, message: refError });
    }

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
    const refError = await validateAgentReferences(req.user._id, req.body);
    if (refError) {
      return res.status(404).json({ success: false, message: refError });
    }
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

// ─── PROMPT PLAYGROUND ──────────────────────────────────────────────────────
// POST /api/agents/playground
// Test a system prompt + user message via LLM without a full voice call.
// Completely free — uses Groq. Great for rapid prompt iteration.
router.post('/playground', async (req, res, next) => {
  try {
    const { systemPrompt, userMessage, model = 'llama-3.1-8b-instant', temperature = 0.7, history = [] } = req.body;

    if (!systemPrompt || !userMessage) {
      return res.status(400).json({ success: false, message: 'systemPrompt and userMessage are required' });
    }

    const groqService = require('../services/groqService');

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage },
    ];

    const startMs = Date.now();
    const response = await groqService.generateResponse({
      messages,
      model,
      temperature: Math.max(0, Math.min(1, Number(temperature))),
    });
    const latencyMs = Date.now() - startMs;

    res.json({
      success: true,
      response: response.text,
      model: response.model || model,
      latencyMs,
      tokensUsed: response.usage || null,
    });
  } catch (error) {
    next(error);
  }
});

// ─── PROMPT A/B TEST ────────────────────────────────────────────────────────
// POST /api/agents/ab-test
// Compare two system prompts side-by-side with the same user message.
router.post('/ab-test', async (req, res, next) => {
  try {
    const { promptA, promptB, userMessage, model = 'llama-3.1-8b-instant', temperature = 0.7 } = req.body;

    if (!promptA || !promptB || !userMessage) {
      return res.status(400).json({ success: false, message: 'promptA, promptB, and userMessage are required' });
    }

    const groqService = require('../services/groqService');

    const [resultA, resultB] = await Promise.all([
      (async () => {
        const start = Date.now();
        const resp = await groqService.generateResponse({
          messages: [
            { role: 'system', content: promptA },
            { role: 'user', content: userMessage },
          ],
          model,
          temperature: Number(temperature),
        });
        return { response: resp.text, latencyMs: Date.now() - start };
      })(),
      (async () => {
        const start = Date.now();
        const resp = await groqService.generateResponse({
          messages: [
            { role: 'system', content: promptB },
            { role: 'user', content: userMessage },
          ],
          model,
          temperature: Number(temperature),
        });
        return { response: resp.text, latencyMs: Date.now() - start };
      })(),
    ]);

    res.json({
      success: true,
      model,
      userMessage,
      resultA,
      resultB,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
