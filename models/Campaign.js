const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
  },
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'failed'],
    default: 'draft',
  },
  numbers: [{
    phone: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'calling', 'completed', 'failed', 'voicemail', 'in-progress', 'no-answer', 'declined', 'retry-pending', 'dnc-skipped'],
      default: 'pending',
    },
    callSid: { type: String, default: '' },
    callLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog' },
    error: { type: String, default: '' },
    errorCode: { type: String, default: '' },

    // Retry tracking
    attempts:    { type: Number, default: 0 },
    lastAttempt: { type: Date },
    nextAttempt: { type: Date },        // When this number is eligible for the next dial
    fromNumber:  { type: String, default: '' }, // Which Twilio number was used

    // Timing
    startTime: { type: Date },
    endTime:   { type: Date },
    duration:  { type: Number, default: 0 },
    recordingUrl: { type: String, default: '' },

    // Lead context (variable substitution into firstMessage / systemPrompt)
    variables: { type: mongoose.Schema.Types.Mixed, default: {} },
    failedAt:  { type: Date },
  }],

  // Sender pool — Twilio numbers to rotate through to avoid spam-flagging
  fromNumbers: [{ type: String }],

  // Schedule / timezone-aware dialing window
  schedule: {
    timezone:        { type: String, default: 'Asia/Kolkata' }, // IANA tz
    scheduledStart:  { type: Date },                            // optional explicit start
    dailyStartHour:  { type: Number, default: 9,  min: 0, max: 23 }, // 09:00 local
    dailyEndHour:    { type: Number, default: 19, min: 0, max: 23 }, // 19:00 local
    daysOfWeek:      [{ type: Number, min: 0, max: 6 }],        // 0=Sun..6=Sat; empty = every day
  },

  // Retry policy
  retryPolicy: {
    maxAttempts:    { type: Number, default: 3 },
    backoffMinutes: { type: Number, default: 30 }, // base delay
    backoffStrategy:{ type: String, enum: ['fixed', 'exponential'], default: 'exponential' },
    retryOnStatuses:[{ type: String }],            // e.g. ['no-answer','failed','busy']
  },

  // Concurrency + throttling
  throttle: {
    maxConcurrentCalls: { type: Number, default: 5 },
    callsPerMinute:     { type: Number, default: 30 },
  },

  // Do-Not-Call list (numbers to skip)
  dncNumbers: [{ type: String }],

  // Analytics
  totalNumbers:   { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
  failedCount:    { type: Number, default: 0 },
  retriedCount:   { type: Number, default: 0 },
  dncSkippedCount:{ type: Number, default: 0 },
  completedAt:    { type: Date },
  statistics: {
    totalNumbers: Number,
    completed:    Number,
    failed:       Number,
    noAnswer:     Number,
    successRate:  Number,
    avgDurationS: Number,
    avgAttempts:  Number,
  },
}, { timestamps: true });

// Auto update counts before save
campaignSchema.pre('save', function(next) {
  this.totalNumbers = this.numbers.length;
  this.completedCount = this.numbers.filter(n => n.status === 'completed').length;
  this.failedCount = this.numbers.filter(n => n.status === 'failed').length;
  this.retriedCount = this.numbers.filter(n => (n.attempts || 0) > 1).length;
  this.dncSkippedCount = this.numbers.filter(n => n.status === 'dnc-skipped').length;

  // Don't auto-complete while retry-pending entries still exist.
  if (this.status === 'running') {
    const terminal = ['completed', 'failed', 'dnc-skipped'];
    const allDone = this.numbers.every(n => terminal.includes(n.status));
    if (allDone) {
      this.status = 'completed';
      if (!this.completedAt) this.completedAt = new Date();
    }
  }
  next();
});

campaignSchema.index({ status: 1, 'numbers.nextAttempt': 1 });
campaignSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Campaign', campaignSchema);
