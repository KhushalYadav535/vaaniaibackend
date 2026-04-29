const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
  },
  callLogId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CallLog',
  },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, default: '' },
  interest: { type: String, default: '' },
  status: {
    type: String,
    enum: ['Hot', 'Warm', 'Cold', 'Converted', 'Lost'],
    default: 'Warm',
  },
  value: { type: String, default: '' }, // e.g. "$5,000"
  notes: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Lead', leadSchema);
