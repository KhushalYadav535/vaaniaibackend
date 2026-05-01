const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const Ticket = require('../models/Ticket');
const { protect } = require('../middleware/auth');

router.use(protect);

// @route   GET /api/crm/leads
// @desc    Get all leads for the user
router.get('/leads', async (req, res, next) => {
  try {
    const leads = await Lead.find({ userId: req.user._id })
      .populate('agentId', 'name')
      .sort('-createdAt');
    res.json({ success: true, leads });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/crm/leads
// @desc    Create a new lead (used internally or via API)
router.post('/leads', async (req, res, next) => {
  try {
    const newLead = await Lead.create({
      ...req.body,
      userId: req.user._id,
    });
    res.status(201).json({ success: true, lead: newLead });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/crm/leads/:id
// @desc    Update a lead
router.put('/leads/:id', async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    
    res.json({ success: true, lead });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/crm/leads/:id
// @desc    Delete a lead
router.delete('/leads/:id', async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    
    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/crm/tickets
// @desc    Get all tickets for the user
router.get('/tickets', async (req, res, next) => {
  try {
    const tickets = await Ticket.find({ userId: req.user._id })
      .populate('agentId', 'name')
      .sort('-createdAt');
    res.json({ success: true, tickets });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/crm/tickets
// @desc    Create a new ticket
router.post('/tickets', async (req, res, next) => {
  try {
    const newTicket = await Ticket.create({
      ...req.body,
      userId: req.user._id,
    });
    res.status(201).json({ success: true, ticket: newTicket });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/crm/tickets/:id
// @desc    Update a ticket
router.put('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      req.body,
      { new: true, runValidators: true }
    );
    
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    
    res.json({ success: true, ticket });
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/crm/tickets/:id
// @desc    Delete a ticket
router.delete('/tickets/:id', async (req, res, next) => {
  try {
    const ticket = await Ticket.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    
    res.json({ success: true, message: 'Ticket deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
