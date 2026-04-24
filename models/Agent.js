const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: {
    type: String,
    required: [true, 'Agent name is required'],
    trim: true,
    maxlength: [100, 'Name cannot exceed 100 characters'],
  },
  systemPrompt: {
    type: String,
    required: [true, 'System prompt is required'],
    maxlength: [5000, 'System prompt cannot exceed 5000 characters'],
  },
  firstMessage: {
    type: String,
    required: [true, 'First message is required'],
    maxlength: [500, 'First message cannot exceed 500 characters'],
  },
  voice: {
    provider: {
      type: String,
      enum: ['edge-tts', 'eleven-labs', 'google', 'azure'],
      default: 'edge-tts',
    },
    voiceId: {
      type: String,
      default: 'en-US-JennyNeural', // Edge TTS free voice
    },
    speed: { type: Number, default: 1.0, min: 0.5, max: 2.0 },
    pitch: { type: Number, default: 0 },
  },
  llm: {
    provider: {
      type: String,
      enum: ['groq', 'openai', 'gemini'],
      default: 'groq',
    },
    model: {
      type: String,
      default: 'llama-3.1-8b-instant', // Groq free model
    },
  },
  temperature: { type: Number, default: 0.7, min: 0, max: 1 },
  language: {
    type: String,
    default: 'en',
    // Deepgram language codes: https://developers.deepgram.com/docs/languages
    enum: [
      'en', 'en-IN',
      'hi', 'hi-Latn',
      'multi',
      // South India
      'ta',   // Tamil
      'te',   // Telugu
      'kn',   // Kannada
      'ml',   // Malayalam
      // West India
      'mr',   // Marathi
      'gu',   // Gujarati
      // East India
      'bn',   // Bengali
      // Others
      'ur',   // Urdu
      'pa',   // Punjabi
    ],
  },
  maxDuration: { type: Number, default: 600 }, // seconds
  endCallMessage: { type: String, default: 'Goodbye! Have a great day!' },
  endCallPhrases: [{ type: String }], // e.g. ["bye", "goodbye", "hang up"]

  // Voicemail message for AMD (Answering Machine Detection)
  voicemailMessage: {
    type: String,
    default: '',
    maxlength: [500, 'Voicemail message cannot exceed 500 characters'],
  },

  // Human Handoff / Transfer settings
  transferNumber: { type: String, default: '' }, // Phone number to transfer to
  transferToAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Agent' },
  transferConditions: {
    onNegativeSentiment: { type: Boolean, default: false },
    onKeyPhrases: [{ type: String }], // e.g. ["talk to human", "real person"]
    maxFailedAttempts: { type: Number, default: 3 },
  },

  // Post-Call Automated Actions
  postCallActions: {
    sendSMS: { type: Boolean, default: false },
    sendWhatsApp: { type: Boolean, default: false },
    smsTemplate: {
      type: String,
      default: 'Thank you for your call with {{agentName}}. Summary: {{summary}}',
    },
    whatsappTemplate: {
      type: String,
      default: '🎙️ *Call Summary*\n\nAgent: {{agentName}}\nDuration: {{duration}}\n\n{{summary}}\n\n{{actionItems}}',
    },
  },

  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active',
  },
  callsCount: { type: Number, default: 0 },
  totalMinutes: { type: Number, default: 0 },
  knowledgeBaseId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KnowledgeBase',
    default: null,
  },
  workflowId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workflow',
    default: null,
  },
  // Advanced Config (Retell/Vapi style)
  advanced: {
    backchanneling: { type: Boolean, default: true },
    ambientNoise: { type: String, default: 'none' }, // 'none', 'office', 'cafe'
    detectVoicemail: { type: Boolean, default: true },
    endCallAfterSilenceMs: { type: Number, default: 10000 },
    maxCallDurationS: { type: Number, default: 3600 },
    interruptionSensitivity: { type: Number, default: 0.5, min: 0, max: 1 },
    backgroundDenoising: { type: String, enum: ['none', 'default', 'high'], default: 'default' },
    fillerWords: { type: Boolean, default: false },
    customLlmUrl: { type: String, default: '' }, // Custom Webhook for Bring Your Own LLM
  },
  // Webhook URLs for this agent
  webhooks: {
    callStarted: { type: String, default: '' },
    callEnded: { type: String, default: '' },
    transcriptReady: { type: String, default: '' },
  },
  // Function calling tools mapping
  tools: [{
    type: { type: String, default: 'function' },
    function: {
      name: { type: String, required: true },
      description: { type: String },
      parameters: { type: mongoose.Schema.Types.Mixed }, // JSON schema object
    },
    serverUrl: { type: String }, // Custom webhook URL for this tool
  }],
}, { timestamps: true });

module.exports = mongoose.model('Agent', agentSchema);
