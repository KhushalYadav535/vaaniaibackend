const express = require('express');
const router = express.Router();
const CallLog = require('../models/CallLog');
const { protect } = require('../middleware/auth');

router.use(protect);

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

module.exports = router;
