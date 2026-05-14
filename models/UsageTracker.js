/**
 * Usage Tracker Model
 * Tracks per-user API usage: LLM tokens, TTS minutes, STT minutes, calls count.
 * Supports daily + monthly aggregation and rate limit checks.
 */
const mongoose = require('mongoose');

const dailyUsageSchema = new mongoose.Schema({
  date: { type: String, required: true }, // 'YYYY-MM-DD'
  llmRequests: { type: Number, default: 0 },
  llmTokens: { type: Number, default: 0 },
  ttsCharacters: { type: Number, default: 0 },
  sttMinutes: { type: Number, default: 0 },
  callsStarted: { type: Number, default: 0 },
  callsCompleted: { type: Number, default: 0 },
  embeddingRequests: { type: Number, default: 0 },
}, { _id: false });

const usageTrackerSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  // Current month totals (reset monthly)
  currentMonth: { type: String, default: '' }, // 'YYYY-MM'
  monthlyLlmRequests: { type: Number, default: 0 },
  monthlyLlmTokens: { type: Number, default: 0 },
  monthlyTtsCharacters: { type: Number, default: 0 },
  monthlySttMinutes: { type: Number, default: 0 },
  monthlyCalls: { type: Number, default: 0 },
  monthlyEmbeddingRequests: { type: Number, default: 0 },

  // Lifetime totals
  totalLlmRequests: { type: Number, default: 0 },
  totalCalls: { type: Number, default: 0 },
  totalMinutes: { type: Number, default: 0 },

  // Daily breakdown (last 90 days max)
  dailyUsage: {
    type: [dailyUsageSchema],
    default: [],
  },

  // Rate limit config (overridable per user)
  limits: {
    maxCallsPerDay: { type: Number, default: Number(process.env.MAX_CALLS_PER_DAY || 100) },
    maxLlmRequestsPerDay: { type: Number, default: Number(process.env.MAX_LLM_REQUESTS_PER_DAY || 1000) },
    maxCallsPerMonth: { type: Number, default: Number(process.env.MAX_CALLS_PER_MONTH || 2000) },
  },
}, { timestamps: true });

// Get or create tracker for a user
usageTrackerSchema.statics.getForUser = async function(userId) {
  let tracker = await this.findOne({ userId });
  if (!tracker) {
    tracker = await this.create({ userId });
  }

  // Reset monthly if new month
  const currentMonth = new Date().toISOString().substring(0, 7);
  if (tracker.currentMonth !== currentMonth) {
    tracker.currentMonth = currentMonth;
    tracker.monthlyLlmRequests = 0;
    tracker.monthlyLlmTokens = 0;
    tracker.monthlyTtsCharacters = 0;
    tracker.monthlySttMinutes = 0;
    tracker.monthlyCalls = 0;
    tracker.monthlyEmbeddingRequests = 0;
    await tracker.save();
  }

  return tracker;
};

// Increment usage (called by services)
usageTrackerSchema.statics.track = async function(userId, metrics) {
  const today = new Date().toISOString().substring(0, 10);
  const currentMonth = today.substring(0, 7);

  const inc = {};
  const dailyInc = {};

  if (metrics.llmRequests) {
    inc.monthlyLlmRequests = metrics.llmRequests;
    inc.totalLlmRequests = metrics.llmRequests;
    dailyInc['dailyUsage.$.llmRequests'] = metrics.llmRequests;
  }
  if (metrics.llmTokens) {
    inc.monthlyLlmTokens = metrics.llmTokens;
    dailyInc['dailyUsage.$.llmTokens'] = metrics.llmTokens;
  }
  if (metrics.ttsCharacters) {
    inc.monthlyTtsCharacters = metrics.ttsCharacters;
    dailyInc['dailyUsage.$.ttsCharacters'] = metrics.ttsCharacters;
  }
  if (metrics.sttMinutes) {
    inc.monthlySttMinutes = metrics.sttMinutes;
    dailyInc['dailyUsage.$.sttMinutes'] = metrics.sttMinutes;
  }
  if (metrics.callsStarted) {
    inc.monthlyCalls = metrics.callsStarted;
    inc.totalCalls = metrics.callsStarted;
    dailyInc['dailyUsage.$.callsStarted'] = metrics.callsStarted;
  }
  if (metrics.callsCompleted) {
    dailyInc['dailyUsage.$.callsCompleted'] = metrics.callsCompleted;
  }
  if (metrics.embeddingRequests) {
    inc.monthlyEmbeddingRequests = metrics.embeddingRequests;
    dailyInc['dailyUsage.$.embeddingRequests'] = metrics.embeddingRequests;
  }

  // Try to update existing daily entry
  const result = await this.updateOne(
    { userId, currentMonth, 'dailyUsage.date': today },
    { $inc: { ...inc, ...dailyInc } }
  );

  // If no daily entry for today, push a new one
  if (result.modifiedCount === 0) {
    const dailyEntry = { date: today };
    if (metrics.llmRequests) dailyEntry.llmRequests = metrics.llmRequests;
    if (metrics.llmTokens) dailyEntry.llmTokens = metrics.llmTokens;
    if (metrics.ttsCharacters) dailyEntry.ttsCharacters = metrics.ttsCharacters;
    if (metrics.sttMinutes) dailyEntry.sttMinutes = metrics.sttMinutes;
    if (metrics.callsStarted) dailyEntry.callsStarted = metrics.callsStarted;
    if (metrics.callsCompleted) dailyEntry.callsCompleted = metrics.callsCompleted;
    if (metrics.embeddingRequests) dailyEntry.embeddingRequests = metrics.embeddingRequests;

    await this.updateOne(
      { userId },
      {
        $inc: inc,
        $set: { currentMonth },
        $push: { dailyUsage: { $each: [dailyEntry], $slice: -90 } }, // keep 90 days
      },
      { upsert: true }
    );
  }
};

// Check if user has exceeded daily limits
usageTrackerSchema.statics.checkLimits = async function(userId) {
  const tracker = await this.getForUser(userId);
  const today = new Date().toISOString().substring(0, 10);
  const todayUsage = (tracker.dailyUsage || []).find(d => d.date === today);

  const limits = tracker.limits || {};
  const exceeded = {};

  if (todayUsage) {
    if (limits.maxCallsPerDay && todayUsage.callsStarted >= limits.maxCallsPerDay) {
      exceeded.dailyCalls = { current: todayUsage.callsStarted, limit: limits.maxCallsPerDay };
    }
    if (limits.maxLlmRequestsPerDay && todayUsage.llmRequests >= limits.maxLlmRequestsPerDay) {
      exceeded.dailyLlm = { current: todayUsage.llmRequests, limit: limits.maxLlmRequestsPerDay };
    }
  }
  if (limits.maxCallsPerMonth && tracker.monthlyCalls >= limits.maxCallsPerMonth) {
    exceeded.monthlyCalls = { current: tracker.monthlyCalls, limit: limits.maxCallsPerMonth };
  }

  return {
    allowed: Object.keys(exceeded).length === 0,
    exceeded,
    usage: {
      today: todayUsage || {},
      monthly: {
        llmRequests: tracker.monthlyLlmRequests,
        calls: tracker.monthlyCalls,
        sttMinutes: tracker.monthlySttMinutes,
        ttsCharacters: tracker.monthlyTtsCharacters,
      },
    },
  };
};

module.exports = mongoose.model('UsageTracker', usageTrackerSchema);
