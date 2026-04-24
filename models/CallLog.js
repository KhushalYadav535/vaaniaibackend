const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  role: { type: String, enum: ['user', 'assistant', 'system'], required: true },
  content: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  latencyMs: { type: Number }, // how long it took to generate
});

const callLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
  },
  agentName: { type: String },

  // Call details
  fromNumber: { type: String, default: '' },
  toNumber: { type: String, default: '' },
  direction: {
    type: String,
    enum: ['inbound', 'outbound', 'web'],
    default: 'web',
  },

  // Status
  status: {
    type: String,
    enum: ['completed', 'failed', 'ongoing', 'no-answer'],
    default: 'ongoing',
  },

  // Timing
  startTime: { type: Date, default: Date.now },
  endTime: { type: Date },
  duration: { type: Number, default: 0 }, // seconds

  // Conversation
  transcript: [messageSchema],
  summary: { type: String, default: '' },

  // Recording
  recordingUrl: { type: String, default: '' },

  // Cost (in cents)
  costCents: { type: Number, default: 0 },

  // Metadata
  callSid: { type: String, default: '' }, // Twilio Call SID
  sessionId: { type: String, default: '' }, // WebSocket session for web calls

  // Sentiment/Analysis
  sentiment: {
    type: String,
    enum: ['positive', 'neutral', 'negative', ''],
    default: '',
  },
  emotion: {
    type: String, // 'happy', 'angry', 'sad', 'frustrated'
    default: 'neutral'
  },
  metrics: {
    nps: { type: Number, min: 0, max: 10 }, // Net Promoter Score
    csat: { type: Number, min: 0, max: 5 }, // Customer Satisfaction
    effort: { type: Number, min: 0, max: 5 }, // Customer Effort Score
  },
  qa: {
    score: { type: Number, min: 0, max: 100 }, // 0-100 QA score
    grade: { type: String, enum: ['A', 'B', 'C', 'D', 'F', ''] },
    feedback: String,
    reviewer: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  crm: {
    status: { type: String, enum: ['synced', 'pending', 'error', 'not_integrated'] },
    refId: String, // ID in external CRM (HubSpot/Salesforce)
    lastSync: Date
  },

  // Voicemail/AMD Detection
  answeredBy: {
    type: String,
    enum: ['human', 'machine', 'fax', 'unknown', ''],
    default: '',
  },

  // Live Sentiment Timeline (real-time tracking during call)
  liveSentimentTimeline: [{
    timestamp: { type: Date, default: Date.now },
    sentiment: { type: String, enum: ['positive', 'neutral', 'negative'] },
    score: { type: Number, min: -1, max: 1 },
    text: { type: String },
  }],

  // Enhanced Post-Call Analysis
  topics: [{ type: String }],
  decisions: [{ type: String }],
  customerIntent: { type: String, default: '' },
  urgencyLevel: {
    type: String,
    enum: ['low', 'medium', 'high', 'critical', ''],
    default: '',
  },
  followUpRequired: { type: Boolean, default: false },

  actionItems: [{ type: String }],
  extractedData: { type: Map, of: mongoose.Schema.Types.Mixed },

  // Transfer/Handoff
  transferredTo: { type: String, default: '' },
  transferReason: { type: String, default: '' },

  // Post-Call Notifications
  notificationsSent: [{
    channel: { type: String, enum: ['sms', 'whatsapp', 'email'] },
    to: { type: String },
    sentAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['sent', 'failed', 'pending'], default: 'pending' },
    messageSid: { type: String, default: '' },
  }],

  endReason: { type: String, default: '' }, // 'user_hangup', 'agent_hangup', 'timeout', 'error', 'voicemail'
}, { timestamps: true });

module.exports = mongoose.model('CallLog', callLogSchema);
