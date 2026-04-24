const mongoose = require('mongoose');

const userMemorySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  phone: { type: String, required: true }, // The user's phone number
  facts: [{
    content: String,
    category: String, // e.g. 'preference', 'past_order', 'personal'
    lastUpdated: { type: Date, default: Date.now }
  }],
  lastCallId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog' },
  metadata: { type: Map, of: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

// Ensure unique memory per phone number for a user
userMemorySchema.index({ userId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('UserMemory', userMemorySchema);
