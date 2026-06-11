const express = require('express');
const router = express.Router();
const Campaign = require('../models/Campaign');
const Agent = require('../models/Agent');
const { protect } = require('../middleware/auth');

router.use(protect);

/**
 * Normalize an incoming numbers payload into the Campaign.numbers shape.
 * Accepts either:
 *   - ["+1555...", "+1555..."]                       (plain strings)
 *   - [{ phone, name, variables: {...} }, ...]       (rich objects)
 */
function normalizeNumbers(phoneNumbers) {
  return phoneNumbers
    .map((entry) => {
      if (typeof entry === 'string') {
        return { phone: entry.trim(), status: 'pending', variables: {} };
      }
      if (entry && typeof entry === 'object' && entry.phone) {
        const { phone, variables, ...rest } = entry;
        return {
          phone: String(phone).trim(),
          status: 'pending',
          // Keep any extra per-lead fields (name, product, etc.) as variables
          variables: variables && typeof variables === 'object' ? variables : rest,
        };
      }
      return null;
    })
    .filter((n) => n && n.phone);
}

// Get all campaigns
router.get('/', async (req, res, next) => {
  try {
    const campaigns = await Campaign.find({ userId: req.user._id })
      .populate('agentId', 'name')
      .sort({ createdAt: -1 });
    res.json({ success: true, campaigns });
  } catch (error) {
    next(error);
  }
});

// Get a single campaign (with live progress)
router.get('/:id', async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id })
      .populate('agentId', 'name');
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    res.json({ success: true, campaign });
  } catch (error) {
    next(error);
  }
});

// Create campaign
router.post('/', async (req, res, next) => {
  try {
    const {
      name,
      agentId,
      phoneNumbers,
      fromNumbers,
      schedule,
      retryPolicy,
      throttle,
      dncNumbers,
      status,
    } = req.body;

    if (!name || !agentId || !phoneNumbers || !Array.isArray(phoneNumbers)) {
      return res.status(400).json({ success: false, message: 'name, agentId and phoneNumbers[] are required' });
    }

    // Ownership check — prevent attaching another tenant's agent
    const agent = await Agent.findOne({ _id: agentId, userId: req.user._id }).select('_id');
    if (!agent) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }

    const numbers = normalizeNumbers(phoneNumbers);
    if (numbers.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid phone numbers provided' });
    }

    const campaign = await Campaign.create({
      userId: req.user._id,
      name,
      agentId,
      numbers,
      totalNumbers: numbers.length,
      // Optional advanced config — falls back to schema defaults when omitted
      ...(Array.isArray(fromNumbers) ? { fromNumbers } : {}),
      ...(schedule && typeof schedule === 'object' ? { schedule } : {}),
      ...(retryPolicy && typeof retryPolicy === 'object' ? { retryPolicy } : {}),
      ...(throttle && typeof throttle === 'object' ? { throttle } : {}),
      ...(Array.isArray(dncNumbers) ? { dncNumbers } : {}),
      status: status === 'scheduled' ? 'scheduled' : 'draft',
    });

    res.status(201).json({ success: true, campaign });
  } catch (error) {
    next(error);
  }
});

// Update campaign config (only while not actively running)
router.put('/:id', async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    if (campaign.status === 'running') {
      return res.status(400).json({ success: false, message: 'Pause the campaign before editing it' });
    }

    const { name, fromNumbers, schedule, retryPolicy, throttle, dncNumbers, phoneNumbers, agentId } = req.body;

    if (name) campaign.name = name;
    if (Array.isArray(fromNumbers)) campaign.fromNumbers = fromNumbers;
    if (schedule && typeof schedule === 'object') campaign.schedule = { ...campaign.schedule, ...schedule };
    if (retryPolicy && typeof retryPolicy === 'object') campaign.retryPolicy = { ...campaign.retryPolicy, ...retryPolicy };
    if (throttle && typeof throttle === 'object') campaign.throttle = { ...campaign.throttle, ...throttle };
    if (Array.isArray(dncNumbers)) campaign.dncNumbers = dncNumbers;

    if (agentId) {
      const agent = await Agent.findOne({ _id: agentId, userId: req.user._id }).select('_id');
      if (!agent) return res.status(404).json({ success: false, message: 'Agent not found' });
      campaign.agentId = agentId;
    }

    // Allow appending fresh numbers; existing in-flight entries are preserved
    if (Array.isArray(phoneNumbers)) {
      const fresh = normalizeNumbers(phoneNumbers);
      campaign.numbers.push(...fresh);
    }

    await campaign.save();
    res.json({ success: true, campaign });
  } catch (error) {
    next(error);
  }
});

// Start a campaign
router.post('/:id/start', async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    if (campaign.status === 'completed') {
      return res.status(400).json({ success: false, message: 'Campaign already completed' });
    }
    if (campaign.status === 'running') {
      return res.status(400).json({ success: false, message: 'Campaign is already running' });
    }

    campaign.status = 'running';
    await campaign.save();

    res.json({ success: true, message: 'Campaign started', campaign });
  } catch (error) {
    next(error);
  }
});

// Pause a campaign
router.post('/:id/pause', async (req, res, next) => {
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

// Resume a paused campaign
router.post('/:id/resume', async (req, res, next) => {
  try {
    const campaign = await Campaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });

    if (campaign.status !== 'paused') {
      return res.status(400).json({ success: false, message: 'Only paused campaigns can be resumed' });
    }

    campaign.status = 'running';
    await campaign.save();

    res.json({ success: true, message: 'Campaign resumed', campaign });
  } catch (error) {
    next(error);
  }
});

// Delete a campaign
router.delete('/:id', async (req, res, next) => {
  try {
    const campaign = await Campaign.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, message: 'Campaign not found' });
    res.json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
