const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const Ticket = require('../models/Ticket');
const { protect, checkPermission } = require('../middleware/auth');

router.use(protect);

// @route   GET /api/crm/leads
// @desc    Get leads for the user (paginated + filterable)
router.get('/leads', checkPermission('crm_view'), async (req, res, next) => {
  try {
    const { status, search, page = 1, limit = 50, sortBy = 'createdAt', order = 'desc' } = req.query;
    const query = { userId: req.effectiveUserId };
    if (req.user.accountType === 'member' && req.user.restrictAgents) {
      query.agentId = { $in: req.user.assignedAgents || [] };
    }
    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const sort = { [sortBy]: order === 'asc' ? 1 : -1 };

    const [leads, total] = await Promise.all([
      Lead.find(query)
        .populate('agentId', 'name')
        .sort(sort)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      Lead.countDocuments(query),
    ]);

    res.json({
      success: true,
      leads,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/crm/leads
// @desc    Create a new lead (used internally or via API)
router.post('/leads', checkPermission('crm_create'), async (req, res, next) => {
  try {
    const newLead = await Lead.create({
      ...req.body,
      userId: req.effectiveUserId,
    });
    res.status(201).json({ success: true, lead: newLead });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/crm/leads/:id
// @desc    Update a lead
router.put('/leads/:id', checkPermission('crm_edit'), async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndUpdate(
      { _id: req.params.id, userId: req.effectiveUserId },
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
router.delete('/leads/:id', checkPermission('crm_delete'), async (req, res, next) => {
  try {
    const lead = await Lead.findOneAndDelete({ _id: req.params.id, userId: req.effectiveUserId });
    
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }
    
    res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/crm/tickets
// @desc    Get tickets for the user (paginated + filterable)
router.get('/tickets', checkPermission('crm_view'), async (req, res, next) => {
  try {
    const { status, priority, search, page = 1, limit = 50, sortBy = 'createdAt', order = 'desc' } = req.query;
    const query = { userId: req.effectiveUserId };
    if (req.user.accountType === 'member' && req.user.restrictAgents) {
      query.agentId = { $in: req.user.assignedAgents || [] };
    }
    if (status && status !== 'all') query.status = status;
    if (priority && priority !== 'all') query.priority = priority;
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { issue: { $regex: search, $options: 'i' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const sort = { [sortBy]: order === 'asc' ? 1 : -1 };

    const [tickets, total] = await Promise.all([
      Ticket.find(query)
        .populate('agentId', 'name')
        .sort(sort)
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum),
      Ticket.countDocuments(query),
    ]);

    res.json({
      success: true,
      tickets,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/crm/tickets
// @desc    Create a new ticket
router.post('/tickets', checkPermission('crm_create'), async (req, res, next) => {
  try {
    const newTicket = await Ticket.create({
      ...req.body,
      userId: req.effectiveUserId,
    });
    res.status(201).json({ success: true, ticket: newTicket });
  } catch (error) {
    next(error);
  }
});

// @route   PUT /api/crm/tickets/:id
// @desc    Update a ticket
router.put('/tickets/:id', checkPermission('crm_edit'), async (req, res, next) => {
  try {
    const ticket = await Ticket.findOneAndUpdate(
      { _id: req.params.id, userId: req.effectiveUserId },
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
router.delete('/tickets/:id', checkPermission('crm_delete'), async (req, res, next) => {
  try {
    const ticket = await Ticket.findOneAndDelete({ _id: req.params.id, userId: req.effectiveUserId });
    
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }
    
    res.json({ success: true, message: 'Ticket deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
