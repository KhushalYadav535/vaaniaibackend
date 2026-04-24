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
    enum: ['draft', 'running', 'paused', 'completed', 'failed'],
    default: 'draft',
  },
  numbers: [{
    phone: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'calling', 'completed', 'failed', 'voicemail', 'in-progress'],
      default: 'pending',
    },
    callSid: { type: String, default: '' },
    error: { type: String, default: '' },
  }],
  // Analytics
  totalNumbers: { type: Number, default: 0 },
  completedCount: { type: Number, default: 0 },
  failedCount: { type: Number, default: 0 },
}, { timestamps: true });

// Auto update counts before save
campaignSchema.pre('save', function(next) {
  this.totalNumbers = this.numbers.length;
  this.completedCount = this.numbers.filter(n => n.status === 'completed').length;
  this.failedCount = this.numbers.filter(n => n.status === 'failed').length;
  
  if (this.status === 'running' && this.completedCount + this.failedCount === this.totalNumbers) {
    this.status = 'completed';
  }
  next();
});

module.exports = mongoose.model('Campaign', campaignSchema);
