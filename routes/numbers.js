const express = require('express');
const router = express.Router();
const PhoneNumber = require('../models/PhoneNumber');
const Agent = require('../models/Agent');
const { protect } = require('../middleware/auth');

router.use(protect);

// @route   GET /api/numbers
router.get('/', async (req, res, next) => {
  try {
    const numbers = await PhoneNumber.find({ userId: req.user._id })
      .populate('assignedAgent', 'name status')
      .sort('-createdAt');
    res.json({ success: true, count: numbers.length, numbers });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/numbers/:id
router.get('/:id', async (req, res, next) => {
  try {
    const number = await PhoneNumber.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('assignedAgent', 'name status');
    if (!number) return res.status(404).json({ success: false, message: 'Phone number not found' });
    res.json({ success: true, number });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/numbers
router.post('/', async (req, res, next) => {
  try {
    const { number, country, type, provider, providerSid, monthlyCost } = req.body;

    const existing = await PhoneNumber.findOne({ number });
    if (existing) return res.status(400).json({ success: false, message: 'Phone number already exists' });

    const phoneNumber = await PhoneNumber.create({
      userId: req.user._id,
      number,
      country: country || 'United States',
      type: type || 'local',
      provider: provider || 'twilio',
      providerSid: providerSid || '',
      monthlyCost: monthlyCost || 100,
    });

    res.status(201).json({ success: true, number: phoneNumber });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/numbers/:id
router.put('/:id', async (req, res, next) => {
  try {
    const number = await PhoneNumber.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true, runValidators: true }
    ).populate('assignedAgent', 'name status');
    if (!number) return res.status(404).json({ success: false, message: 'Phone number not found' });
    res.json({ success: true, number });
  } catch (error) {
    next(error);
  }
});

// @route   PATCH /api/numbers/:id/assign
router.patch('/:id/assign', async (req, res, next) => {
  try {
    const { agentId } = req.body;

    if (agentId) {
      const agent = await Agent.findOne({ _id: agentId, userId: req.user._id });
      if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const number = await PhoneNumber.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { assignedAgent: agentId || null },
      { new: true }
    ).populate('assignedAgent', 'name status');

    if (!number) return res.status(404).json({ success: false, message: 'Phone number not found' });
    res.json({ success: true, number });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/numbers/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const number = await PhoneNumber.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!number) return res.status(404).json({ success: false, message: 'Phone number not found' });
    res.json({ success: true, message: 'Phone number deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
