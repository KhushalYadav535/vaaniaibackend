const express = require('express');
const router = express.Router();
const Webhook = require('../models/Webhook');
const { protect } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(protect);

// @route   GET /api/webhooks
router.get('/', async (req, res, next) => {
  try {
    const webhooks = await Webhook.find({ userId: req.user._id }).sort('-createdAt');
    res.json({ success: true, count: webhooks.length, webhooks });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/webhooks
router.post('/', async (req, res, next) => {
  try {
    const { name, url, events, headers } = req.body;
    const secret = req.body.secret || uuidv4().replace(/-/g, '');

    const webhook = await Webhook.create({
      userId: req.user._id,
      name,
      url,
      events: events || ['call.ended'],
      secret,
      headers: headers || {},
    });

    res.status(201).json({ success: true, webhook });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/webhooks/:id
router.put('/:id', async (req, res, next) => {
  try {
    const webhook = await Webhook.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!webhook) return res.status(404).json({ success: false, message: 'Webhook not found' });
    res.json({ success: true, webhook });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/webhooks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const webhook = await Webhook.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!webhook) return res.status(404).json({ success: false, message: 'Webhook not found' });
    res.json({ success: true, message: 'Webhook deleted' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/webhooks/:id/test
router.post('/:id/test', async (req, res, next) => {
  try {
    const webhook = await Webhook.findOne({ _id: req.params.id, userId: req.user._id });
    if (!webhook) return res.status(404).json({ success: false, message: 'Webhook not found' });

    const fetch = require('node-fetch');
    const payload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test webhook from VaaniAI' },
    };

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...Object.fromEntries(webhook.headers) },
      body: JSON.stringify(payload),
      timeout: 5000,
    });

    await Webhook.findByIdAndUpdate(webhook._id, { lastTriggered: new Date() });

    res.json({
      success: true,
      statusCode: response.status,
      message: response.ok ? 'Webhook test successful ✅' : 'Webhook responded with error',
    });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Failed to reach webhook URL: ' + error.message });
  }
});

// @route   GET /api/webhooks/logs
router.get('/logs', async (req, res, next) => {
  try {
    const WebhookLog = require('../models/WebhookLog');
    const logs = await WebhookLog.find({ userId: req.user._id })
      .populate('webhookId', 'name url')
      .sort('-createdAt')
      .limit(50);
    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/webhooks/:id/logs
router.get('/:id/logs', async (req, res, next) => {
  try {
    const WebhookLog = require('../models/WebhookLog');
    const logs = await WebhookLog.find({ webhookId: req.params.id, userId: req.user._id })
      .sort('-createdAt')
      .limit(50);
    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
