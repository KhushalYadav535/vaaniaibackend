/**
 * Usage Limiter Middleware
 * Checks if user has exceeded their daily/monthly limits before allowing API calls.
 * Attach to routes that consume LLM/STT/TTS resources.
 */
const UsageTracker = require('../models/UsageTracker');

const usageLimiter = (resource = 'calls') => {
  return async (req, res, next) => {
    try {
      if (!req.user?._id) return next(); // Skip if no auth

      const check = await UsageTracker.checkLimits(req.user._id);

      if (!check.allowed) {
        const reasons = Object.entries(check.exceeded)
          .map(([key, val]) => `${key}: ${val.current}/${val.limit}`)
          .join(', ');

        return res.status(429).json({
          success: false,
          message: `Usage limit exceeded: ${reasons}`,
          exceeded: check.exceeded,
          usage: check.usage,
        });
      }

      // Attach usage info to request for downstream use
      req.usageInfo = check.usage;
      next();
    } catch (error) {
      // Don't block requests if usage tracking fails
      console.error('[UsageLimiter] Check failed:', error.message);
      next();
    }
  };
};

module.exports = usageLimiter;
