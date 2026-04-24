const express = require('express');
const router = express.Router();
const Campaign = require('../models/Campaign');
const { protect } = require('../middleware/auth');

// Get all campaigns
router.get('/', protect, async (req, res, next) => {
  try {
    const campaigns = await Campaign.find({ userId: req.user._id })
      .populate('agentId', 'name')
      .sort({ createdAt: -1 });
    res.json({ success: true, campaigns });
  } catch (error) {
    next(error);
  }
});

// Create campaign
router.post('/', protect, async (req, res, next) => {
  try {
    const { name, agentId, phoneNumbers } = req.body;
    
    if (!name || !agentId || !phoneNumbers || !Array.isArray(phoneNumbers)) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const numbers = phoneNumbers.map(phone => ({ phone, status: 'pending' }));
    
    const campaign = await Campaign.create({
      userId: req.user._id,
      name,
      agentId,
      numbers,
      totalNumbers: numbers.length,
      status: 'draft'
    });

    res.status(201).json({ success: true, campaign });
  } catch (error) {
    next(error);
  }
});

// Start a campaign
router.post('/:id/start', protect, async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    
    if (campaign.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Campaign already completed' });
    }

    campaign.status = 'running';
    await campaign.save();

    res.json({ success: true, message: 'Campaign started', campaign });
  } catch (error) {
    next(error);
  }
});

// Pause a campaign
router.post('/:id/pause', protect, async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    
    if (campaign.status !== 'running') {
      return res.status(400).json({ success: false, message: 'Only running campaigns can be paused' });
    }

    campaign.status = 'paused';
    await campaign.save();

    res.json({ success: true, message: 'Campaign paused', campaign });
  } catch (error) {
    next(error);
  }
});

// Delete a campaign
router.delete('/:id', protect, async (req, res, next) => {
  try {
    const campaign = await Campaign.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    res.json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
