const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ─── Default Permissions (all false — owner gets all, member gets what's assigned) ──
const defaultPermissions = {
  // Agents
  agents_view:   { type: Boolean, default: false },
  agents_create: { type: Boolean, default: false },
  agents_edit:   { type: Boolean, default: false },
  agents_delete: { type: Boolean, default: false },
  agents_test:   { type: Boolean, default: false },
  // Agent Templates
  agent_templates_view:   { type: Boolean, default: false },
  agent_templates_create: { type: Boolean, default: false },
  agent_templates_edit:   { type: Boolean, default: false },
  agent_templates_delete: { type: Boolean, default: false },
  // CRM & Leads
  crm_view:      { type: Boolean, default: false },
  crm_create:    { type: Boolean, default: false },
  crm_edit:      { type: Boolean, default: false },
  crm_delete:    { type: Boolean, default: false },
  // Visitors
  visitors_view:   { type: Boolean, default: false },
  visitors_create: { type: Boolean, default: false },
  visitors_edit:   { type: Boolean, default: false },
  visitors_delete: { type: Boolean, default: false },
  // Chats
  chats_view:   { type: Boolean, default: false },
  chats_create: { type: Boolean, default: false },
  chats_edit:   { type: Boolean, default: false },
  chats_delete: { type: Boolean, default: false },
  // Call Flows
  callflows_view:   { type: Boolean, default: false },
  callflows_create: { type: Boolean, default: false },
  callflows_edit:   { type: Boolean, default: false },
  callflows_delete: { type: Boolean, default: false },
  // Knowledge Base
  kb_view:   { type: Boolean, default: false },
  kb_create: { type: Boolean, default: false },
  kb_edit:   { type: Boolean, default: false },
  kb_delete: { type: Boolean, default: false },
  // Campaigns
  campaigns_view:   { type: Boolean, default: false },
  campaigns_create: { type: Boolean, default: false },
  campaigns_edit:   { type: Boolean, default: false },
  campaigns_delete: { type: Boolean, default: false },
  // Analytics
  analytics_view: { type: Boolean, default: false },
  // Call Logs
  calllogs_view: { type: Boolean, default: false },
  // Settings
  settings_view: { type: Boolean, default: false },
  settings_edit: { type: Boolean, default: false },
  // Phone Numbers
  numbers_view: { type: Boolean, default: false },
  // Webhooks
  webhooks_view:   { type: Boolean, default: false },
  webhooks_create: { type: Boolean, default: false },
  webhooks_edit:   { type: Boolean, default: false },
  webhooks_delete: { type: Boolean, default: false },
  // Playground
  playground_view: { type: Boolean, default: false },
  playground_test: { type: Boolean, default: false },
  // Test Suites
  test_suites_view:   { type: Boolean, default: false },
  test_suites_create: { type: Boolean, default: false },
  test_suites_edit:   { type: Boolean, default: false },
  test_suites_delete: { type: Boolean, default: false },
};

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false,
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'super_admin'],
    default: 'user',
  },

  // ─── Team / RBAC ────────────────────────────────────────────────────────────
  // 'owner' = main account holder; 'member' = sub-user created by an owner
  accountType: {
    type: String,
    enum: ['owner', 'member'],
    default: 'owner',
  },
  // For members only: reference to the owner whose data they access
  ownerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Granular permissions — only meaningful for members; owners have full access
  permissions: {
    type: Map,
    of: Boolean,
    default: () => ({}),
  },
  // Restrict access to specific agents (if false, member can view/test all agents)
  restrictAgents: {
    type: Boolean,
    default: false,
  },
  // The specific agents this member is allowed to access
  assignedAgents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
  }],
  // Owner can deactivate a member to block login without deleting the account
  isActive: {
    type: Boolean,
    default: true,
  },

  // API Keys stored per user (encrypted in real prod, plain for dev)
  settings: {
    groqKey: { type: String, default: '' },
    openaiKey: { type: String, default: '' },
    geminiKey: { type: String, default: '' },
    deepgramKey: { type: String, default: '' },
    elevenLabsKey: { type: String, default: '' },
    twilioAccountSid: { type: String, default: '' },
    twilioAuthToken: { type: String, default: '' },
    twilioPhoneNumber: { type: String, default: '' },
    twilioWhatsAppNumber: { type: String, default: '' }, // e.g. 'whatsapp:+14155238886'
    // Plivo credentials (user-level — overrides env vars)
    plivoAuthId: { type: String, default: '' },
    plivoAuthToken: { type: String, default: '' },
    plivoPhoneNumber: { type: String, default: '' }, // default outbound number
    preferredLlm: { type: String, default: 'groq' },
    preferredTts: { type: String, default: 'edge-tts' }, // free by default
    // Webhook / n8n Integration
    postCallWebhookUrl: { type: String, default: '' }, // n8n / Zapier / custom webhook URL
    webhookSecret: { type: String, default: '' },      // Optional HMAC secret for verification
  },
  createdAt: { type: Date, default: Date.now },
});

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Check password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
