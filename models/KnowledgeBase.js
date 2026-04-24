const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema({
  text: { type: String, required: true },       // The chunk text (~500 chars)
  summary: { type: String, default: '' },        // LLM-generated keywords/summary
  keywords: [{ type: String }],                  // Extracted keywords for search
  index: { type: Number, required: true },       // Position in original document
}, { _id: false });

const knowledgeBaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  
  // Source
  sourceType: {
    type: String,
    enum: ['text', 'pdf', 'url'],
    default: 'text',
  },
  sourceUrl: { type: String, default: '' },
  fileName: { type: String, default: '' },
  fileSize: { type: Number, default: 0 },
  
  // Content
  content: { type: String, default: '' },        // Original full text
  chunks: [chunkSchema],                          // Processed chunks for RAG
  totalChunks: { type: Number, default: 0 },
  
  // Processing status
  status: {
    type: String,
    enum: ['processing', 'ready', 'error'],
    default: 'processing',
  },
  errorMessage: { type: String, default: '' },
  
}, { timestamps: true });

// Index for efficient user lookups
knowledgeBaseSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('KnowledgeBase', knowledgeBaseSchema);
