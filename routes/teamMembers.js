const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

// All team-member routes require authentication
router.use(protect);

// ─── Only owners can manage team members ────────────────────────────────────
const ownerOnly = (req, res, next) => {
  if (req.user.accountType !== 'owner') {
    return res.status(403).json({
      success: false,
      message: 'Only account owners can manage team members.',
    });
  }
  next();
};

// ─── Helper: safe member projection (never expose password) ─────────────────
const MEMBER_FIELDS = 'name email accountType ownerId permissions restrictAgents assignedAgents isActive createdAt';

// ─── @route  GET /api/team-members ──────────────────────────────────────────
// List all team members created by this owner
router.get('/', ownerOnly, async (req, res, next) => {
  try {
    const members = await User.find({
      accountType: 'member',
      ownerId: req.user._id,
    }).select(MEMBER_FIELDS).sort({ createdAt: -1 });

    // Convert permissions Map to plain object for JSON response
    const membersData = members.map(m => ({
      ...m.toObject(),
      permissions: m.permissions ? Object.fromEntries(m.permissions) : {},
    }));

    res.json({ success: true, count: members.length, members: membersData });
  } catch (error) {
    next(error);
  }
});

// ─── @route  POST /api/team-members ─────────────────────────────────────────
// Create a new team member
router.post('/', ownerOnly, async (req, res, next) => {
  try {
    const { name, email, password, permissions = {}, restrictAgents = false, assignedAgents = [] } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email, and password',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    // Email must be unique across all users
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'This email is already registered. Please use a different email.',
      });
    }

    // Build permissions Map from the plain object
    const permissionsMap = new Map(Object.entries(permissions).map(([k, v]) => [k, Boolean(v)]));

    const member = await User.create({
      name,
      email,
      password,
      accountType: 'member',
      ownerId: req.user._id,
      permissions: permissionsMap,
      restrictAgents,
      assignedAgents,
      isActive: true,
      role: 'user',
    });

    res.status(201).json({
      success: true,
      member: {
        id: member._id,
        name: member.name,
        email: member.email,
        accountType: member.accountType,
        ownerId: member.ownerId,
        permissions: Object.fromEntries(member.permissions),
        restrictAgents: member.restrictAgents,
        assignedAgents: member.assignedAgents,
        isActive: member.isActive,
        createdAt: member.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── @route  PUT /api/team-members/:id ──────────────────────────────────────
// Update a team member's name, password, and/or permissions
router.put('/:id', ownerOnly, async (req, res, next) => {
  try {
    const member = await User.findOne({
      _id: req.params.id,
      accountType: 'member',
      ownerId: req.user._id,
    });

    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    const { name, password, permissions, restrictAgents, assignedAgents } = req.body;

    if (name) member.name = name;

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
      }
      member.password = password; // pre-save hook will hash it
    }

    if (permissions && typeof permissions === 'object') {
      member.permissions = new Map(
        Object.entries(permissions).map(([k, v]) => [k, Boolean(v)])
      );
    }

    if (restrictAgents !== undefined) member.restrictAgents = restrictAgents;
    if (assignedAgents !== undefined) member.assignedAgents = assignedAgents;

    await member.save();

    res.json({
      success: true,
      member: {
        id: member._id,
        name: member.name,
        email: member.email,
        accountType: member.accountType,
        ownerId: member.ownerId,
        permissions: Object.fromEntries(member.permissions),
        isActive: member.isActive,
        createdAt: member.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── @route  PATCH /api/team-members/:id/toggle ─────────────────────────────
// Toggle isActive (enable / disable a team member)
router.patch('/:id/toggle', ownerOnly, async (req, res, next) => {
  try {
    const member = await User.findOne({
      _id: req.params.id,
      accountType: 'member',
      ownerId: req.user._id,
    });

    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    member.isActive = !member.isActive;
    await member.save();

    res.json({
      success: true,
      isActive: member.isActive,
      message: member.isActive ? 'Team member activated' : 'Team member deactivated',
    });
  } catch (error) {
    next(error);
  }
});

// ─── @route  DELETE /api/team-members/:id ───────────────────────────────────
// Permanently delete a team member
router.delete('/:id', ownerOnly, async (req, res, next) => {
  try {
    const member = await User.findOneAndDelete({
      _id: req.params.id,
      accountType: 'member',
      ownerId: req.user._id,
    });

    if (!member) {
      return res.status(404).json({ success: false, message: 'Team member not found' });
    }

    res.json({ success: true, message: 'Team member deleted successfully' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
