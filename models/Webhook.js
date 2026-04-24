const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: [true, 'Webhook name is required'],
    trim: true,
  },
  url: {
    type: String,
    required: [true, 'Webhook URL is required'],
    trim: true,
  },
  events: [{
    type: String,
    enum: ['call.started', 'call.ended', 'call.failed', 'transcript.ready', 'agent.created', 'agent.updated'],
  }],
  secret: { type: String, default: '' }, // HMAC secret for verification
  isActive: { type: Boolean, default: true },
  lastTriggered: { type: Date },
  failureCount: { type: Number, default: 0 },
  headers: { type: Map, of: String, default: {} }, // custom headers
}, { timestamps: true });

module.exports = mongoose.model('Webhook', webhookSchema);
