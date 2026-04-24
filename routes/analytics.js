const express = require('express');
const router = express.Router();
const CallLog = require('../models/CallLog');
const Agent = require('../models/Agent');
const { protect } = require('../middleware/auth');

router.use(protect);

// @route   GET /api/analytics/overview
router.get('/overview', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const userId = req.user._id;

    const daysMap = { '7d': 7, '30d': 30, '90d': 90 };
    const days = daysMap[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [
      totalCalls,
      completedCalls,
      failedCalls,
      totalAgents,
      activeAgents,
    ] = await Promise.all([
      CallLog.countDocuments({ userId, startTime: { $gte: startDate } }),
      CallLog.countDocuments({ userId, status: 'completed', startTime: { $gte: startDate } }),
      CallLog.countDocuments({ userId, status: 'failed', startTime: { $gte: startDate } }),
      Agent.countDocuments({ userId }),
      Agent.countDocuments({ userId, status: 'active' }),
    ]);

    // Total duration & QA score
    const durationResult = await CallLog.aggregate([
      { $match: { userId, status: 'completed', startTime: { $gte: startDate } } },
      { $group: { _id: null, totalDuration: { $sum: '$duration' }, totalCost: { $sum: '$costCents' }, avgQaScore: { $avg: '$qa.score' } } },
    ]);

    const totalDuration = durationResult[0]?.totalDuration || 0;
    const totalCost = durationResult[0]?.totalCost || 0;
    const avgQaScore = durationResult[0]?.avgQaScore ? Math.round(durationResult[0].avgQaScore) : 0;
    const avgDuration = totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0;
    const successRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 100) : 0;

    res.json({
      success: true,
      overview: {
        totalCalls,
        completedCalls,
        failedCalls,
        totalAgents,
        activeAgents,
        totalDurationSeconds: totalDuration,
        totalDurationMinutes: Math.round(totalDuration / 60),
        totalCostCents: totalCost,
        avgDurationSeconds: avgDuration,
        successRate,
        avgQaScore,
        period,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/calls-over-time
router.get('/calls-over-time', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const userId = req.user._id;

    const daysMap = { '7d': 7, '30d': 30, '90d': 90 };
    const days = daysMap[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$startTime' } },
          calls: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
          duration: { $sum: '$duration' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/top-agents
router.get('/top-agents', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const userId = req.user._id;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate } } },
      {
        $group: {
          _id: '$agentId',
          agentName: { $first: '$agentName' },
          totalCalls: { $sum: 1 },
          totalDuration: { $sum: '$duration' },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        },
      },
      { $sort: { totalCalls: -1 } },
      { $limit: 5 },
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/sentiment-distribution
// @desc    Get sentiment breakdown for calls
router.get('/sentiment-distribution', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const userId = req.user._id;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate }, sentiment: { $ne: '' } } },
      {
        $group: {
          _id: '$sentiment',
          count: { $sum: 1 },
          avgDuration: { $avg: '$duration' },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/intent-distribution
// @desc    Get customer intent breakdown for calls
router.get('/intent-distribution', async (req, res, next) => {
  try {
    const { period = '30d' } = req.query;
    const userId = req.user._id;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate }, customerIntent: { $ne: '' }, status: 'completed' } },
      {
        $group: {
          _id: '$customerIntent',
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/voicemail-stats
// @desc    Get AMD/voicemail detection stats for campaigns
router.get('/voicemail-stats', async (req, res, next) => {
  try {
    const userId = req.user._id;

    const data = await CallLog.aggregate([
      { $match: { userId, direction: 'outbound' } },
      {
        $group: {
          _id: '$answeredBy',
          count: { $sum: 1 },
        },
      },
    ]);

    const total = data.reduce((sum, d) => sum + d.count, 0);
    const voicemailCount = data.find(d => d._id === 'machine')?.count || 0;
    const humanCount = data.find(d => d._id === 'human')?.count || 0;

    res.json({
      success: true,
      data,
      summary: {
        total,
        humanRate: total > 0 ? Math.round((humanCount / total) * 100) : 0,
        voicemailRate: total > 0 ? Math.round((voicemailCount / total) * 100) : 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/follow-up-stats
// @desc    Get post-call notification stats
router.get('/follow-up-stats', async (req, res, next) => {
  try {
    const userId = req.user._id;

    const data = await CallLog.aggregate([
      { $match: { userId, 'notificationsSent.0': { $exists: true } } },
      { $unwind: '$notificationsSent' },
      {
        $group: {
          _id: {
            channel: '$notificationsSent.channel',
            status: '$notificationsSent.status',
          },
          count: { $sum: 1 },
        },
      },
    ]);

    const followUpRequired = await CallLog.countDocuments({
      userId,
      followUpRequired: true,
      status: 'completed',
    });

    res.json({ success: true, data, followUpRequired });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/peak-hours
// @desc    Heatmap data: calls by hour of day and day of week
router.get('/peak-hours', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { period = '30d' } = req.query;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate } } },
      {
        $group: {
          _id: {
            hour: { $hour: '$startTime' },
            dayOfWeek: { $dayOfWeek: '$startTime' },
          },
          count: { $sum: 1 },
          avgDuration: { $avg: '$duration' },
        },
      },
      { $sort: { '_id.dayOfWeek': 1, '_id.hour': 1 } },
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/agent-comparison
// @desc    Compare agents: calls, avg duration, sentiment breakdown, success rate
router.get('/agent-comparison', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { period = '30d' } = req.query;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate } } },
      {
        $group: {
          _id: { agentId: '$agentId', agentName: '$agentName' },
          totalCalls: { $sum: 1 },
          avgDuration: { $avg: '$duration' },
          totalDuration: { $sum: '$duration' },
          completedCalls: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] },
          },
          positiveSentiment: {
            $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] },
          },
          negativeSentiment: {
            $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] },
          },
          followUpsRequired: {
            $sum: { $cond: ['$followUpRequired', 1, 0] },
          },
        },
      },
      {
        $project: {
          agentName: '$_id.agentName',
          agentId: '$_id.agentId',
          totalCalls: 1,
          avgDuration: { $round: ['$avgDuration', 0] },
          totalMinutes: { $round: [{ $divide: ['$totalDuration', 60] }, 1] },
          successRate: {
            $round: [{ $multiply: [{ $divide: ['$completedCalls', { $max: ['$totalCalls', 1] }] }, 100] }, 1],
          },
          positiveSentiment: 1,
          negativeSentiment: 1,
          followUpsRequired: 1,
        },
      },
      { $sort: { totalCalls: -1 } },
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/call-duration-distribution
// @desc    Histogram: how many calls in each duration bucket
router.get('/call-duration-distribution', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { period = '30d' } = req.query;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate }, status: 'completed' } },
      {
        $bucket: {
          groupBy: '$duration',
          boundaries: [0, 30, 60, 120, 300, 600, Infinity],
          default: '600+',
          output: {
            count: { $sum: 1 },
            avgSentimentScore: { $avg: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, { $cond: [{ $eq: ['$sentiment', 'negative'] }, -1, 0] }] } },
          },
        },
      },
    ]);

    // Label the buckets
    const labels = ['0-30s', '30-60s', '1-2m', '2-5m', '5-10m', '10m+'];
    const result = data.map((d, i) => ({
      bucket: labels[i] || `${d._id}`,
      count: d.count,
      avgSentimentScore: Math.round((d.avgSentimentScore || 0) * 100) / 100,
    }));

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/conversion-funnel
// @desc    Funnel: total → answered → completed → positive → follow-up sent
router.get('/conversion-funnel', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { period = '30d' } = req.query;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [total, answered, completed, positive, followUpSent, transferred] = await Promise.all([
      CallLog.countDocuments({ userId, startTime: { $gte: startDate } }),
      CallLog.countDocuments({ userId, startTime: { $gte: startDate }, answeredBy: { $in: ['human', ''] } }),
      CallLog.countDocuments({ userId, startTime: { $gte: startDate }, status: 'completed' }),
      CallLog.countDocuments({ userId, startTime: { $gte: startDate }, sentiment: 'positive' }),
      CallLog.countDocuments({ userId, startTime: { $gte: startDate }, 'notificationsSent.0': { $exists: true } }),
      CallLog.countDocuments({ userId, startTime: { $gte: startDate }, transferredTo: { $ne: '' } }),
    ]);

    res.json({
      success: true,
      funnel: [
        { stage: 'Total Calls', count: total },
        { stage: 'Answered (Human)', count: answered },
        { stage: 'Completed', count: completed },
        { stage: 'Positive Sentiment', count: positive },
        { stage: 'Follow-up Sent', count: followUpSent },
        { stage: 'Transferred', count: transferred },
      ],
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/analytics/trends
// @desc    Daily sentiment + call volume trends
router.get('/trends', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { period = '30d' } = req.query;
    const days = { '7d': 7, '30d': 30, '90d': 90 }[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const data = await CallLog.aggregate([
      { $match: { userId, startTime: { $gte: startDate } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$startTime' },
          },
          totalCalls: { $sum: 1 },
          avgDuration: { $avg: '$duration' },
          positive: {
            $sum: { $cond: [{ $eq: ['$sentiment', 'positive'] }, 1, 0] },
          },
          negative: {
            $sum: { $cond: [{ $eq: ['$sentiment', 'negative'] }, 1, 0] },
          },
          neutral: {
            $sum: { $cond: [{ $eq: ['$sentiment', 'neutral'] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
