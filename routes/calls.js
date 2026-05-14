const express = require('express');
const router = express.Router();
const CallLog = require('../models/CallLog');
const { protect } = require('../middleware/auth');

router.use(protect);

// ─── FULL-TEXT SEARCH across all transcripts ────────────────────────────────
// GET /api/calls/search?q=refund&agentId=xxx&limit=20
router.get('/search', async (req, res, next) => {
  try {
    const { q, agentId, limit = 20, status, direction } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Search query must be at least 2 characters' });
    }

    const query = {
      userId: req.user._id,
      'transcript.content': { $regex: q.trim(), $options: 'i' },
    };
    if (agentId) query.agentId = agentId;
    if (status && status !== 'all') query.status = status;
    if (direction && direction !== 'all') query.direction = direction;

    const calls = await CallLog.find(query)
      .populate('agentId', 'name')
      .select('agentName startTime duration status sentiment direction summary transcript tags')
      .sort('-startTime')
      .limit(Math.min(parseInt(limit), 100));

    // Highlight matching transcript lines
    const results = calls.map(call => {
      const matchedLines = (call.transcript || []).filter(msg =>
        msg.content && msg.content.toLowerCase().includes(q.trim().toLowerCase())
      ).slice(0, 3); // max 3 matched lines per call

      return {
        ...call.toObject(),
        matchedLines,
        matchCount: matchedLines.length,
      };
    });

    res.json({ success: true, query: q, total: results.length, results });
  } catch (error) {
    next(error);
  }
});

// ─── EXPORT transcripts as CSV/JSON/TXT ─────────────────────────────────────
// GET /api/calls/:id/export?format=csv|json|txt
router.get('/:id/export', async (req, res, next) => {
  try {
    const { format = 'json' } = req.query;
    const call = await CallLog.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('agentId', 'name');
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });

    const agentName = call.agentId?.name || call.agentName || 'Unknown';
    const dateStr = new Date(call.startTime).toISOString().split('T')[0];
    const filename = `vaaniai_call_${agentName.replace(/\s+/g, '_')}_${dateStr}`;

    if (format === 'csv') {
      const lines = ['Timestamp,Role,Content'];
      for (const msg of (call.transcript || [])) {
        const ts = msg.timestamp ? new Date(msg.timestamp).toISOString() : '';
        const content = (msg.content || '').replace(/"/g, '""');
        lines.push(`"${ts}","${msg.role}","${content}"`);
      }
      // Add metadata rows
      lines.push('');
      lines.push(`"Agent","${agentName}"`);
      lines.push(`"Duration","${call.duration}s"`);
      lines.push(`"Sentiment","${call.sentiment || 'N/A'}"`);
      lines.push(`"Status","${call.status}"`);
      if (call.summary) lines.push(`"Summary","${call.summary.replace(/"/g, '""')}"`);

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(lines.join('\n'));
    }

    if (format === 'txt') {
      let text = `VaaniAI Call Transcript\n`;
      text += `Agent: ${agentName}\n`;
      text += `Date: ${new Date(call.startTime).toLocaleString()}\n`;
      text += `Duration: ${Math.round(call.duration / 60)}m ${call.duration % 60}s\n`;
      text += `Status: ${call.status} | Sentiment: ${call.sentiment || 'N/A'}\n`;
      text += `${'─'.repeat(60)}\n\n`;

      for (const msg of (call.transcript || [])) {
        const role = msg.role === 'assistant' ? `🤖 ${agentName}` : '👤 Customer';
        text += `${role}:\n${msg.content}\n\n`;
      }

      if (call.summary) text += `\n${'─'.repeat(60)}\nSummary: ${call.summary}\n`;

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
      return res.send(text);
    }

    // Default: JSON export
    const exportData = {
      callId: call._id,
      agent: agentName,
      startTime: call.startTime,
      endTime: call.endTime,
      duration: call.duration,
      status: call.status,
      direction: call.direction,
      sentiment: call.sentiment,
      summary: call.summary,
      topics: call.topics,
      customerIntent: call.customerIntent,
      tags: call.tags,
      transcript: (call.transcript || []).map(m => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
    return res.json(exportData);
  } catch (error) {
    next(error);
  }
});

// ─── BULK EXPORT all calls as CSV ───────────────────────────────────────────
// GET /api/calls/export/bulk?format=csv&period=30d
router.get('/export/bulk', async (req, res, next) => {
  try {
    const { period = '30d', format = 'csv' } = req.query;
    const daysMap = { '7d': 7, '30d': 30, '90d': 90, 'all': 3650 };
    const days = daysMap[period] || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const calls = await CallLog.find({
      userId: req.user._id,
      startTime: { $gte: startDate },
    })
      .populate('agentId', 'name')
      .sort('-startTime')
      .limit(5000);

    if (format === 'csv') {
      const lines = ['Date,Agent,Direction,Status,Duration(s),Sentiment,Summary,Tags,Messages'];
      for (const call of calls) {
        const date = new Date(call.startTime).toISOString();
        const agent = (call.agentId?.name || call.agentName || '').replace(/,/g, ' ');
        const summary = (call.summary || '').replace(/"/g, '""').substring(0, 200);
        const tags = (call.tags || []).join('; ');
        const msgCount = (call.transcript || []).length;
        lines.push(`"${date}","${agent}","${call.direction}","${call.status}",${call.duration},"${call.sentiment || ''}","${summary}","${tags}",${msgCount}`);
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="vaaniai_calls_export_${period}.csv"`);
      return res.send(lines.join('\n'));
    }

    // JSON format
    const exportData = calls.map(c => ({
      id: c._id,
      agent: c.agentId?.name || c.agentName,
      date: c.startTime,
      direction: c.direction,
      status: c.status,
      duration: c.duration,
      sentiment: c.sentiment,
      summary: c.summary,
      tags: c.tags,
      messageCount: (c.transcript || []).length,
    }));
    res.json({ success: true, total: exportData.length, calls: exportData });
  } catch (error) {
    next(error);
  }
});

// ─── BULK DELETE calls ──────────────────────────────────────────────────────
// POST /api/calls/bulk-delete  { callIds: [...] }
router.post('/bulk-delete', async (req, res, next) => {
  try {
    const { callIds } = req.body;
    if (!callIds || !Array.isArray(callIds) || callIds.length === 0) {
      return res.status(400).json({ success: false, message: 'callIds array required' });
    }
    const result = await CallLog.deleteMany({
      _id: { $in: callIds.slice(0, 100) }, // max 100 at once
      userId: req.user._id,
    });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (error) {
    next(error);
  }
});

// ─── CALL TAGS ──────────────────────────────────────────────────────────────
// PATCH /api/calls/:id/tags  { tags: ['vip', 'escalated'] }
router.patch('/:id/tags', async (req, res, next) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ success: false, message: 'tags must be an array of strings' });
    }
    const cleanTags = tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase()).slice(0, 20);
    const call = await CallLog.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { tags: cleanTags },
      { new: true }
    );
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, tags: call.tags });
  } catch (error) {
    next(error);
  }
});

// ─── CALL STATS SUMMARY ─────────────────────────────────────────────────────
// GET /api/calls/stats/summary
router.get('/stats/summary', async (req, res, next) => {
  try {
    const userId = req.user._id;
    const [total, completed, avgDuration, sentimentBreakdown, tagCloud] = await Promise.all([
      CallLog.countDocuments({ userId }),
      CallLog.countDocuments({ userId, status: 'completed' }),
      CallLog.aggregate([
        { $match: { userId, status: 'completed' } },
        { $group: { _id: null, avg: { $avg: '$duration' } } },
      ]),
      CallLog.aggregate([
        { $match: { userId, sentiment: { $ne: '' } } },
        { $group: { _id: '$sentiment', count: { $sum: 1 } } },
      ]),
      CallLog.aggregate([
        { $match: { userId, tags: { $exists: true, $ne: [] } } },
        { $unwind: '$tags' },
        { $group: { _id: '$tags', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ]),
    ]);

    res.json({
      success: true,
      stats: {
        totalCalls: total,
        completedCalls: completed,
        avgDurationSeconds: avgDuration[0]?.avg ? Math.round(avgDuration[0].avg) : 0,
        sentimentBreakdown: sentimentBreakdown.reduce((acc, s) => ({ ...acc, [s._id]: s.count }), {}),
        topTags: tagCloud,
      },
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/calls
router.get('/', async (req, res, next) => {
  try {
    const {
      agentId,
      status,
      direction,
      page = 1,
      limit = 20,
      startDate,
      endDate,
    } = req.query;

    const query = { userId: req.user._id };
    if (agentId) query.agentId = agentId;
    if (status && status !== 'all') query.status = status;
    if (direction && direction !== 'all') query.direction = direction;
    if (startDate || endDate) {
      query.startTime = {};
      if (startDate) query.startTime.$gte = new Date(startDate);
      if (endDate) query.startTime.$lte = new Date(endDate);
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await CallLog.countDocuments(query);

    const calls = await CallLog.find(query)
      .populate('agentId', 'name')
      .sort('-startTime')
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      calls,
    });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/calls/active
router.get('/active', async (req, res, next) => {
  try {
    const activeCalls = await CallLog.find({ userId: req.user._id, status: 'ongoing' })
      .populate('agentId', 'name')
      .sort('-startTime');
    res.json({ success: true, activeCalls });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/calls/:id
router.get('/:id', async (req, res, next) => {
  try {
    const call = await CallLog.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('agentId', 'name voice llm');
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, call });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/calls/:id/transcript
router.get('/:id/transcript', async (req, res, next) => {
  try {
    const call = await CallLog.findOne({ _id: req.params.id, userId: req.user._id })
      .select('transcript agentName fromNumber toNumber startTime endTime duration status');
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, transcript: call.transcript, meta: call });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/calls/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const call = await CallLog.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, message: 'Call log deleted' });
  } catch (error) {
    next(error);
  }
});

// @route   PATCH /api/calls/:id/qa — Manual QA score override
router.patch('/:id/qa', async (req, res, next) => {
  try {
    const { score, grade, feedback } = req.body;
    const update = {};
    if (score !== undefined) update['qa.score'] = Math.max(0, Math.min(100, Number(score)));
    if (grade) update['qa.grade'] = grade;
    if (feedback) update['qa.feedback'] = feedback;
    update['qa.reviewer'] = req.user._id;

    const call = await CallLog.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: update },
      { new: true }
    );
    if (!call) return res.status(404).json({ success: false, message: 'Call not found' });
    res.json({ success: true, qa: call.qa });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
