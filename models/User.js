const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
