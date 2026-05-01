/**
 * Widget Routes (PUBLIC - No Auth Required)
 * 
 * These routes power the embeddable web widget.
 * External websites load widget.js → iframe opens widget page → 
 * widget page calls these APIs to get agent config + session token →
 * WebSocket voice session starts with the widget token.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Agent = require('../models/Agent');
const User = require('../models/User');

// @route   GET /api/widget/:agentId/config
// @desc    Get public agent config for widget (no auth needed)
// @access  Public
router.get('/:agentId/config', async (req, res, next) => {
  try {
    const agent = await Agent.findById(req.params.agentId).select(
      'name firstMessage voice language status userId'
    );

    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    if (agent.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Agent is not active' });
    }

    res.json({
      success: true,
      agent: {
        id: agent._id,
        name: agent.name,
        firstMessage: agent.firstMessage,
        language: agent.language,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/widget/:agentId/session
// @desc    Create a short-lived widget session token for voice calls
// @access  Public (rate-limited)
router.post('/:agentId/session', async (req, res, next) => {
  try {
    const agent = await Agent.findById(req.params.agentId);

    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    if (agent.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Agent is not active' });
    }

    // Find the agent owner
    const owner = await User.findById(agent.userId);
    if (!owner) {
      return res.status(404).json({ success: false, message: 'Agent owner not found' });
    }

    // Create a short-lived widget token (15 min expiry)
    const widgetToken = jwt.sign(
      {
        id: owner._id,
        agentId: agent._id.toString(),
        type: 'widget',
      },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({
      success: true,
      token: widgetToken,
      agent: {
        id: agent._id,
        name: agent.name,
        firstMessage: agent.firstMessage,
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
