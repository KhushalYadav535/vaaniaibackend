const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * protect — verifies JWT and loads user onto req.user.
 * For team members (accountType === 'member'):
 *   - Checks isActive flag (deactivated members are rejected)
 *   - Sets req.effectiveUserId = ownerId so all data queries use owner's data
 * For owners (accountType === 'owner'):
 *   - req.effectiveUserId = req.user._id (their own data)
 */
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized, no token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');

    if (!req.user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    // Block deactivated members
    if (req.user.accountType === 'member' && !req.user.isActive) {
      return res.status(403).json({ success: false, message: 'Your account has been deactivated. Please contact the account owner.' });
    }

    // Set effectiveUserId: members work on owner's data, owners work on their own data
    req.effectiveUserId = req.user.accountType === 'member'
      ? req.user.ownerId
      : req.user._id;

    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Not authorized, token invalid' });
  }
};

/**
 * checkPermission(permissionKey) — middleware factory.
 * Owners always pass. Members must have the specific permission set to true.
 *
 * Permission keys follow the pattern: `${module}_${action}`
 * Examples: 'agents_view', 'agents_delete', 'crm_create', 'callflows_edit'
 *
 * Usage in routes:
 *   router.post('/', checkPermission('agents_create'), handler)
 *   router.delete('/:id', checkPermission('agents_delete'), handler)
 */
const checkPermission = (permissionKey) => (req, res, next) => {
  // Owners and super_admins always have full access
  if (req.user.accountType === 'owner' || req.user.role === 'super_admin') {
    return next();
  }

  // For members: check their permissions map
  const perms = req.user.permissions;
  const hasPermission = perms && (perms.get ? perms.get(permissionKey) : perms[permissionKey]);

  if (!hasPermission) {
    return res.status(403).json({
      success: false,
      message: `Access denied. You don't have permission to perform this action (${permissionKey}).`,
    });
  }

  next();
};

const authorizeSuperAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'super_admin') {
    next();
  } else {
    res.status(403).json({ success: false, message: 'Not authorized as super admin' });
  }
};

module.exports = { protect, checkPermission, authorizeSuperAdmin };
