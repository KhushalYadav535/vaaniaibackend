const express = require('express');
const router = express.Router();
const CallFlow = require('../models/CallFlow');
const Agent = require('../models/Agent');
const { protect } = require('../middleware/auth');

// All routes require auth
router.use(protect);

// Validate that any attached agentId belongs to the requesting user.
// Returns true when no agentId is supplied (it's optional).
async function ownsAgentOrNull(userId, agentId) {
  if (!agentId) return true;
  const agent = await Agent.findOne({ _id: agentId, userId }).select('_id');
  return !!agent;
}

// @route   GET /api/call-flows
// @desc    Get user's call flows
router.get('/', async (req, res, next) => {
  try {
    const flows = await CallFlow.find({ userId: req.user._id }).sort('-createdAt');
    res.json({ success: true, count: flows.length, flows });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/call-flows/:id
// @desc    Get single call flow
router.get('/:id', async (req, res, next) => {
  try {
    const flow = await CallFlow.findOne({ _id: req.params.id, userId: req.user._id });
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Call flow not found' });
    }
    res.json({ success: true, flow });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/call-flows
// @desc    Create a new call flow
router.post('/', async (req, res, next) => {
  try {
    if (!(await ownsAgentOrNull(req.user._id, req.body.agentId))) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    const flowData = { ...req.body, userId: req.user._id };
    const flow = await CallFlow.create(flowData);
    res.status(201).json({ success: true, flow });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/call-flows/:id
// @desc    Update a call flow
router.put('/:id', async (req, res, next) => {
  try {
    if (!(await ownsAgentOrNull(req.user._id, req.body.agentId))) {
      return res.status(404).json({ success: false, message: 'Agent not found' });
    }
    let flow = await CallFlow.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Call flow not found' });
    }
    res.json({ success: true, flow });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/call-flows/:id
// @desc    Delete a call flow
router.delete('/:id', async (req, res, next) => {
  try {
    const flow = await CallFlow.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!flow) {
      return res.status(404).json({ success: false, message: 'Call flow not found' });
    }
    res.json({ success: true, message: 'Call flow deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
