/**
 * Super Admin Routes
 * Only accessible by role === 'super_admin'
 * 
 * Endpoints:
 *  GET  /api/super-admin/stats          → Platform-wide stats
 *  GET  /api/super-admin/users          → All users with their usage data
 *  GET  /api/super-admin/users/:id      → Single user detail + all their agents/calls
 *  PUT  /api/super-admin/users/:id/subscription → Update plan/status
 *  DELETE /api/super-admin/users/:id   → Delete user
 *  GET  /api/super-admin/calls         → All recent calls across platform
 *  GET  /api/super-admin/activity      → Recent activity feed
 */

const express = require('express');
const router = express.Router();
const User    = require('../models/User');
const Agent   = require('../models/Agent');
const CallLog = require('../models/CallLog');
const Campaign = require('../models/Campaign');
const KnowledgeBase = require('../models/KnowledgeBase');

const { protect, authorizeSuperAdmin } = require('../middleware/auth');

router.use(protect);
router.use(authorizeSuperAdmin);

function ensureSuperAdminWriteEnabled(res) {
  const enabled = String(process.env.SUPER_ADMIN_WRITE_ENABLED || 'false').toLowerCase() === 'true';
  if (!enabled) {
    res.status(403).json({
      success: false,
      message: 'Super admin write operations are disabled. Set SUPER_ADMIN_WRITE_ENABLED=true to allow changes.',
    });
    return false;
  }
  return true;
}

// ─── GET /stats ─────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      totalAgents,
      totalCalls,
      totalCampaigns,
      totalKBs,
      recentUsers,
      callsToday,
      callsThisWeek,
    ] = await Promise.all([
      User.countDocuments({ role: { $ne: 'super_admin' } }),
      Agent.countDocuments(),
      CallLog.countDocuments(),
      Campaign.countDocuments(),
      KnowledgeBase.countDocuments(),

      // New users in last 30 days
      User.countDocuments({
        role: { $ne: 'super_admin' },
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      }),

      // Calls today
      CallLog.countDocuments({
        createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
      }),

      // Calls this week
      CallLog.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      }),
    ]);

    // Total call minutes
    const minutesAgg = await CallLog.aggregate([
      { $group: { _id: null, totalDuration: { $sum: '$duration' } } }
    ]);
    const totalMinutes = Math.round((minutesAgg[0]?.totalDuration || 0) / 60);

    // Avg calls per user
    const avgCallsPerUser = totalUsers > 0 ? (totalCalls / totalUsers).toFixed(1) : 0;

    // Top 5 most active users
    const topUsers = await CallLog.aggregate([
      { $group: { _id: '$userId', callCount: { $sum: 1 } } },
      { $sort: { callCount: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user'
        }
      },
      { $unwind: '$user' },
      { $project: { callCount: 1, 'user.name': 1, 'user.email': 1 } }
    ]);

    // Calls per day for last 7 days (chart data)
    const callsChart = await CallLog.aggregate([
      { $match: { createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        totalAgents,
        totalCalls,
        totalCampaigns,
        totalKBs,
        totalMinutes,
        recentUsers,       // last 30 days
        callsToday,
        callsThisWeek,
        avgCallsPerUser,
        topUsers,
        callsChart,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /users ──────────────────────────────────────────────────────────────
// Returns all users with their agent count, call count, and storage usage
router.get('/users', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 50 } = req.query;

    const query = { role: { $ne: 'super_admin' } };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
      ];
    }

    const users = await User.find(query)
      .select('-password')
      .sort('-createdAt')
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    const total = await User.countDocuments(query);

    // Enrich with usage data (agent count, call count per user)
    const userIds = users.map(u => u._id);

    const [agentCounts, callCounts] = await Promise.all([
      Agent.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 } } }
      ]),
      CallLog.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: '$userId', count: { $sum: 1 }, totalDuration: { $sum: '$duration' } } }
      ]),
    ]);

    const agentMap = Object.fromEntries(agentCounts.map(a => [a._id.toString(), a.count]));
    const callMap  = Object.fromEntries(callCounts.map(c => [c._id.toString(), { count: c.count, duration: c.totalDuration }]));

    const enriched = users.map(u => ({
      ...u.toObject(),
      _usage: {
        agents:      agentMap[u._id.toString()] || 0,
        calls:       callMap[u._id.toString()]?.count || 0,
        totalMinutes: Math.round((callMap[u._id.toString()]?.duration || 0) / 60),
      }
    }));

    res.json({ success: true, data: enriched, total, page: Number(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /users/:id ──────────────────────────────────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const [agents, recentCalls, campaigns, kbs] = await Promise.all([
      Agent.find({ userId: user._id }).select('name status callsCount totalMinutes createdAt'),
      CallLog.find({ userId: user._id }).sort('-createdAt').limit(10).select('agentName duration status startTime direction'),
      Campaign.find({ userId: user._id }).select('name status createdAt'),
      KnowledgeBase.find({ userId: user._id }).select('name status createdAt'),
    ]);

    res.json({
      success: true,
      data: {
        user: user.toObject(),
        agents,
        recentCalls,
        campaigns,
        kbs,
        summary: {
          totalAgents: agents.length,
          activeAgents: agents.filter(a => a.status === 'active').length,
          totalCalls: recentCalls.length,
          totalCampaigns: campaigns.length,
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /users/:id/subscription ─────────────────────────────────────────────
router.put('/users/:id/subscription', async (req, res) => {
  try {
    if (!ensureSuperAdminWriteEnabled(res)) return;
    const { plan, status } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.settings = { ...user.toObject().settings, plan, subscriptionStatus: status };
    await user.save();

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── PUT /users/:id/role ──────────────────────────────────────────────────────
router.put('/users/:id/role', async (req, res) => {
  try {
    if (!ensureSuperAdminWriteEnabled(res)) return;
    const { role } = req.body;
    const allowed = ['user', 'admin'];
    if (!allowed.includes(role)) return res.status(400).json({ success: false, message: 'Invalid role' });

    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── DELETE /users/:id ───────────────────────────────────────────────────────
router.delete('/users/:id', async (req, res) => {
  try {
    if (!ensureSuperAdminWriteEnabled(res)) return;
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Also delete all their agents and calls
    await Promise.all([
      Agent.deleteMany({ userId: req.params.id }),
      CallLog.deleteMany({ userId: req.params.id }),
    ]);

    res.json({ success: true, message: 'User and all associated data deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── GET /calls ───────────────────────────────────────────────────────────────
router.get('/calls', async (req, res) => {
  try {
    const calls = await CallLog.find()
      .sort('-createdAt')
      .limit(100)
      .populate('userId', 'name email')
      .select('agentName duration status startTime direction userId sentiment');

    res.json({ success: true, data: calls });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
