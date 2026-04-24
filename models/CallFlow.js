const mongoose = require('mongoose');

const nodeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  type: { type: String, required: true }, // 'trigger', 'speak', 'gather', 'condition', 'transfer', 'api', 'end'
  position: {
    x: { type: Number, required: true },
    y: { type: Number, required: true }
  },
  data: { type: mongoose.Schema.Types.Mixed, default: {} }, // title, text, logic, etc.
  width: { type: Number },
  height: { type: Number },
  selected: { type: Boolean },
  positionAbsolute: { type: mongoose.Schema.Types.Mixed },
  dragging: { type: Boolean }
}, { _id: false });

const edgeSchema = new mongoose.Schema({
  id: { type: String, required: true },
  source: { type: String, required: true },
  target: { type: String, required: true },
  sourceHandle: { type: String },
  targetHandle: { type: String },
  type: { type: String },
  animated: { type: Boolean }
}, { _id: false });

const callFlowSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: true,
    default: 'My Call Flow'
  },
  description: {
    type: String
  },
  nodes: [nodeSchema],
  edges: [edgeSchema],
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent'
  },
  priority: {
    type: String,
    enum: ['low', 'medium', 'high', 'urgent'],
    default: 'medium'
  },
  tags: [String],
  enableRecording: { type: Boolean, default: true },
  allowTransfer: { type: Boolean, default: false },
  enableAnalytics: { type: Boolean, default: true }
}, {
  timestamps: true
});

module.exports = mongoose.model('CallFlow', callFlowSchema);
