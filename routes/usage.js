/**
 * Usage Tracking API Routes
 * GET /api/usage — current user's usage stats
 * GET /api/usage/daily — daily breakdown
 */
const express = require('express');
const router = express.Router();
const UsageTracker = require('../models/UsageTracker');
const { protect } = require('../middleware/auth');

router.use(protect);

// GET /api/usage — Get current usage + limits
router.get('/', async (req, res, next) => {
  try {
    const check = await UsageTracker.checkLimits(req.user._id);
    const tracker = await UsageTracker.getForUser(req.user._id);

    res.json({
      success: true,
      usage: check.usage,
      limits: tracker.limits,
      allowed: check.allowed,
      exceeded: check.exceeded,
      lifetime: {
        totalCalls: tracker.totalCalls,
        totalLlmRequests: tracker.totalLlmRequests,
        totalMinutes: tracker.totalMinutes,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/usage/daily?days=30 — Daily usage breakdown
router.get('/daily', async (req, res, next) => {
  try {
    const { days = 30 } = req.query;
    const tracker = await UsageTracker.getForUser(req.user._id);

    const dailyData = (tracker.dailyUsage || [])
      .slice(-Math.min(parseInt(days), 90))
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ success: true, data: dailyData });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
