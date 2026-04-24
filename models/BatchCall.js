const mongoose = require('mongoose');

const batchCallSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent', required: true },
  name: { type: String, required: true },
  
  // Recipients
  contacts: [{
    phone: String,
    name: String,
    customVariables: Map,
    status: { type: String, enum: ['pending', 'in_progress', 'completed', 'failed'], default: 'pending' },
    callId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallLog' },
    error: String
  }],
  
  // Scheduling
  scheduledAt: { type: Date },
  concurrency: { type: Number, default: 1 }, // How many calls at once
  
  status: { type: String, enum: ['draft', 'scheduled', 'running', 'paused', 'completed'], default: 'draft' },
  
  stats: {
    total: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    duration: { type: Number, default: 0 } // Total minutes
  }
}, { timestamps: true });

module.exports = mongoose.model('BatchCall', batchCallSchema);
