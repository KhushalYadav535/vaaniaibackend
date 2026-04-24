const mongoose = require('mongoose');

const workflowSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  description: { type: String },
  nodes: [{
    id: String,
    type: { type: String, enum: ['trigger', 'agent_speech', 'user_intent', 'condition', 'action', 'end'] },
    data: mongoose.Schema.Types.Mixed,
    position: { x: Number, y: Number }
  }],
  edges: [{
    id: String,
    source: String,
    target: String,
    label: String,
    condition: String
  }],
  status: { type: String, enum: ['draft', 'active', 'archived'], default: 'draft' }
}, { timestamps: true });

module.exports = mongoose.model('Workflow', workflowSchema);
