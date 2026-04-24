const express = require('express');
const router = express.Router();
const multer = require('multer');
const KnowledgeBase = require('../models/KnowledgeBase');
const Agent = require('../models/Agent');
const ragService = require('../services/ragService');
const { protect } = require('../middleware/auth');

router.use(protect);

// Configure multer for memory storage (file upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and TXT files are allowed'));
    }
  }
});

// @route   GET /api/knowledge-base
// @desc    Get all knowledge bases for user
router.get('/', async (req, res, next) => {
  try {
    const kbs = await KnowledgeBase.find({ userId: req.user._id })
      .select('-content -chunks')
      .sort('-createdAt');
    res.json({ success: true, count: kbs.length, data: kbs });
  } catch (error) {
    next(error);
  }
});

// @route   GET /api/knowledge-base/:id
// @desc    Get single knowledge base by ID
router.get('/:id', async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, userId: req.user._id });
    if (!kb) return res.status(404).json({ success: false, message: 'Knowledge base not found' });
    
    // Check if it's attached to any agents
    const attachedAgents = await Agent.find({ knowledgeBaseId: kb._id }).select('name');
    
    // Don't send full chunks to frontend, just metadata
    const kbObj = kb.toObject();
    if (kbObj.chunks) {
      kbObj.chunks = kbObj.chunks.map(c => ({
        index: c.index,
        textPreview: c.text.substring(0, 100) + '...',
        summary: c.summary,
        keywords: c.keywords
      }));
    }
    
    res.json({ success: true, data: { ...kbObj, attachedAgents } });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/knowledge-base/text
// @desc    Create KB from raw text
router.post('/text', async (req, res, next) => {
  try {
    const { name, description, content } = req.body;
    
    if (!name || !content) {
      return res.status(400).json({ success: false, message: 'Name and content are required' });
    }

    const kb = await KnowledgeBase.create({
      userId: req.user._id,
      name,
      description,
      content,
      sourceType: 'text',
      status: 'processing'
    });

    res.status(201).json({ success: true, data: kb });

    // Process in background
    ragService.processDocument(kb._id).catch(err => console.error('RAG processing error:', err));
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/knowledge-base/upload
// @desc    Create KB by uploading a file (PDF or TXT)
router.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Please upload a file' });
    }

    let content = '';
    const name = req.body.name || req.file.originalname;
    const description = req.body.description || '';
    const isPDF = req.file.mimetype === 'application/pdf';

    if (isPDF) {
      content = await ragService.extractTextFromPDF(req.file.buffer);
    } else {
      content = req.file.buffer.toString('utf8');
    }

    if (!content || content.trim() === '') {
      return res.status(400).json({ success: false, message: 'Could not extract text from file' });
    }

    const kb = await KnowledgeBase.create({
      userId: req.user._id,
      name,
      description,
      content,
      sourceType: isPDF ? 'pdf' : 'text',
      fileName: req.file.originalname,
      fileSize: req.file.size,
      status: 'processing'
    });

    res.status(201).json({ success: true, data: kb });

    // Process in background
    ragService.processDocument(kb._id).catch(err => console.error('RAG processing error:', err));
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/knowledge-base/url
// @desc    Create KB by scraping a URL
router.post('/url', async (req, res, next) => {
  try {
    const { name, description, url } = req.body;
    
    if (!name || !url) {
      return res.status(400).json({ success: false, message: 'Name and url are required' });
    }

    const content = await ragService.scrapeUrl(url);
    
    if (!content || content.trim() === '') {
      return res.status(400).json({ success: false, message: 'Could not extract text from URL' });
    }

    const kb = await KnowledgeBase.create({
      userId: req.user._id,
      name,
      description,
      content,
      sourceType: 'url',
      sourceUrl: url,
      status: 'processing'
    });

    res.status(201).json({ success: true, data: kb });

    // Process in background
    ragService.processDocument(kb._id).catch(err => console.error('RAG processing error:', err));
  } catch (error) {
    next(error);
  }
});

// @route   DELETE /api/knowledge-base/:id
// @desc    Delete knowledge base and detach from agents
router.delete('/:id', async (req, res, next) => {
  try {
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, userId: req.user._id });
    if (!kb) return res.status(404).json({ success: false, message: 'Knowledge base not found' });
    
    await kb.deleteOne();
    
    // Detach from agents
    await Agent.updateMany(
      { knowledgeBaseId: kb._id },
      { $set: { knowledgeBaseId: null } }
    );
    
    res.json({ success: true, message: 'Knowledge base deleted' });
  } catch (error) {
    next(error);
  }
});

// @route   POST /api/knowledge-base/:id/search
// @desc    Test RAG search against a knowledge base
router.post('/:id/search', async (req, res, next) => {
  try {
    const { query, topK = 3 } = req.body;
    if (!query) return res.status(400).json({ success: false, message: 'Query is required' });
    
    const kb = await KnowledgeBase.findOne({ _id: req.params.id, userId: req.user._id });
    if (!kb) return res.status(404).json({ success: false, message: 'Knowledge base not found' });
    
    const results = await ragService.searchRelevantChunks(query, kb._id, topK);
    
    res.json({ success: true, count: results.length, data: results });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
