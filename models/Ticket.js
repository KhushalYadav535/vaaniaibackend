const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
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
  issue: { type: String, required: true },
  priority: {
    type: String,
    enum: ['High', 'Medium', 'Low'],
    default: 'Medium',
  },
  status: {
    type: String,
    enum: ['Open', 'In Progress', 'Resolved', 'Closed'],
    default: 'Open',
  },
  resolution: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Ticket', ticketSchema);
