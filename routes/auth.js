const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

// Generate JWT
const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

// ✅ REGISTER
router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, email and password',
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Email already registered',
      });
    }

    const user = await User.create({ name, email, password });

    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ✅ LOGIN (FINAL FIXED)
router.post('/login', async (req, res, next) => {
  try {
    console.log("🔥 LOGIN START");

    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and password',
      });
    }

    // Fetch user
    const user = await User.findOne({ email }).select('+password');
    console.log("✅ USER FETCHED");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: 'Your account is inactive. Please contact the admin.',
      });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    console.log("✅ PASSWORD CHECK DONE");

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password',
      });
    }

    const token = generateToken(user._id);
    console.log("✅ LOGIN SUCCESS");

    return res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        accountType: user.accountType || 'owner',
        ownerId: user.ownerId || null,
        permissions: user.permissions ? Object.fromEntries(user.permissions) : {},
        isActive: user.isActive !== false,
      },
    });

  } catch (error) {
    console.error("❌ LOGIN ERROR:", error);
    next(error);
  }
});

// ✅ GET ME
router.get('/me', protect, async (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    user: {
      id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      settings: u.settings,
      accountType: u.accountType || 'owner',
      ownerId: u.ownerId || null,
      permissions: u.permissions ? Object.fromEntries(u.permissions) : {},
      isActive: u.isActive !== false,
      createdAt: u.createdAt,
    },
  });
});

module.exports = router;