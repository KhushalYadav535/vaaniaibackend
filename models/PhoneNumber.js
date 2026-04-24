const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  number: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true,
  },
  country: { type: String, default: 'United States' },
  countryCode: { type: String, default: 'US' },
  type: {
    type: String,
    enum: ['local', 'toll-free', 'mobile'],
    default: 'local',
  },
  provider: {
    type: String,
    enum: ['twilio', 'telnyx', 'vonage', 'manual'],
    default: 'twilio',
  },
  providerSid: { type: String, default: '' }, // Twilio SID etc.
  assignedAgent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    default: null,
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'pending'],
    default: 'active',
  },
  monthlyCost: { type: Number, default: 100 }, // in cents
  capabilities: {
    voice: { type: Boolean, default: true },
    sms: { type: Boolean, default: false },
  },
}, { timestamps: true });

module.exports = mongoose.model('PhoneNumber', phoneNumberSchema);
