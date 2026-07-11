const express = require('express');
const router = express.Router();
const Agent = require('../models/Agent');

// @route   GET /api/public/agents
// Publicly fetch all active and public agents
router.get('/agents', async (req, res, next) => {
  try {
    // Find agents that are active and NOT explicitly set to private (so undefined/null is treated as true)
    const agents = await Agent.find({ status: 'active', isPublic: { $ne: false } }).sort({ createdAt: -1 });
    res.json({ success: true, agents });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
