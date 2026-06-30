/**
 * RAG Service (Retrieval-Augmented Generation)
 * 
 * Enhanced: Hybrid search with Gemini free embeddings + keywords
 * - Chunk text into overlapping segments
 * - Generate embeddings via Gemini (free text-embedding-004)
 * - Hybrid search: keyword + semantic cosine similarity
 * - Optional Groq reranking for best quality
 * - Uses Gemini embeddings (768 dims) — completely free
 */
const groqService = require('./groqService');
const geminiService = require('./geminiService');
const KnowledgeBase = require('../models/KnowledgeBase');
const pdfParse = require('pdf-parse');

// Polyfill DOMMatrix and Path2D to prevent pdfjs-dist from complaining about missing 'canvas' module
if (typeof global.DOMMatrix === 'undefined') {
  global.DOMMatrix = class DOMMatrix {};
}
if (typeof global.Path2D === 'undefined') {
  global.Path2D = class Path2D {};
}

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

class RAGService {
  constructor() {
    this.contextCache = new Map();
  }

  /**
   * Generate embedding for a single text using Gemini (free).
   * Returns null when Gemini is disabled (USE_GEMINI=false) so the caller
   * automatically falls back to keyword-only search.
   */
  async generateEmbedding(text) {
    if (!geminiService.isEnabled || !geminiService.isEnabled()) return null;
    try {
      return await geminiService.generateEmbedding(text);
    } catch (e) {
      console.error('[RAG] Embedding generation failed:', e.message);
      return null;
    }
  }

  /**
   * Generate embeddings for multiple texts (batch)
   */
  async generateEmbeddings(texts) {
    if (!geminiService.isEnabled || !geminiService.isEnabled()) {
      return texts.map(() => []);
    }
    try {
      return await geminiService.generateEmbeddings(texts);
    } catch (e) {
      console.error('[RAG] Batch embedding generation failed:', e.message);
      // Fallback: generate one by one
      const results = [];
      for (const text of texts) {
        const emb = await this.generateEmbedding(text);
        results.push(emb || []);
      }
      return results;
    }
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length !== vecB.length) {
      return 0;
    }
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Hybrid search: keyword + semantic similarity
   */
  async hybridSearch(query, knowledgeBaseId, topK = 3, semanticWeight = 0.6) {
    const kb = await KnowledgeBase.findById(knowledgeBaseId);
    if (!kb || kb.status !== 'ready' || !kb.chunks || kb.chunks.length === 0) {
      return [];
    }

    // Generate query embedding
    const queryEmbedding = await this.generateEmbedding(query);
    if (!queryEmbedding) {
      // Fallback to keyword-only search
      return this.searchRelevantChunks(query, knowledgeBaseId, topK);
    }

    // Score each chunk
    const scoredChunks = kb.chunks.map(chunk => {
      let score = 0;
      let semanticScore = 0;
      let keywordScore = 0;

      // Semantic similarity
      if (chunk.embedding && Array.isArray(chunk.embedding)) {
        semanticScore = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      }

      // Keyword matching (existing logic)
      const queryLower = query.toLowerCase();
      const queryWords = queryLower.split(/\W+/).filter(w => w.length > 2);
      const chunkLower = chunk.text.toLowerCase();
      const chunkKeywords = (chunk.keywords || []).map(k => k.toLowerCase());

      queryWords.forEach(word => {
        if (chunkLower.includes(word)) keywordScore += 2;
        if (chunkKeywords.includes(word)) keywordScore += 3;
      });

      // Hybrid score
      score = (semanticScore * semanticWeight) + (keywordScore * (1 - semanticWeight));

      return {
        ...chunk.toObject ? chunk.toObject() : chunk,
        score,
        semanticScore,
        keywordScore,
      };
    });

    // Sort and return top K
    return scoredChunks
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }


  /**
   * Chunk text into overlapping segments
   * @param {string} text - Full text to chunk
   * @param {number} chunkSize - Characters per chunk (default 500)
   * @param {number} overlap - Overlap between chunks (default 100)
   * @returns {Array<{text: string, index: number}>}
   */
  chunkText(text, chunkSize = 500, overlap = 100) {
    if (!text || text.length === 0) return [];

    // Clean text
    const cleanText = text
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const chunks = [];
    let start = 0;
    let index = 0;

    while (start < cleanText.length) {
      let end = start + chunkSize;

      // Try to break at sentence boundary
      if (end < cleanText.length) {
        const searchArea = cleanText.substring(end - 50, end + 50);
        const sentenceEnd = searchArea.search(/[.!?]\s/);
        if (sentenceEnd > 0) {
          end = end - 50 + sentenceEnd + 2;
        }
      }

      const chunkText = cleanText.substring(start, Math.min(end, cleanText.length)).trim();

      if (chunkText.length > 20) { // Skip tiny chunks
        chunks.push({
          text: chunkText,
          index: index++,
        });
      }

      start = end - overlap;
      if (start >= cleanText.length) break;
    }

    return chunks;
  }

  /**
   * Generate keywords and summary for a chunk via Groq
   */
  async generateChunkMetadata(chunkText) {
    try {
      const response = await groqService.generateResponse({
        messages: [
          {
            role: 'system',
            content: 'Extract keywords and a one-line summary from the text. Respond ONLY with JSON: {"keywords":["word1","word2"],"summary":"one line summary"}',
          },
          { role: 'user', content: chunkText.substring(0, 800) },
        ],
        model: 'llama-3.1-8b-instant',
        temperature: 0,
      });

      const cleanJson = response.text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleanJson);
      return {
        keywords: parsed.keywords || [],
        summary: parsed.summary || '',
      };
    } catch (e) {
      // Fallback: extract keywords manually
      const words = chunkText.toLowerCase().split(/\W+/).filter(w => w.length > 4);
      const freq = {};
      words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
      const keywords = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(e => e[0]);
      return { keywords, summary: chunkText.substring(0, 100) };
    }
  }

  /**
   * Process a document: chunk → extract metadata → embeddings → save
   * Enhanced with Gemini embeddings for semantic search
   */
  async processDocument(knowledgeBaseId) {
    const kb = await KnowledgeBase.findById(knowledgeBaseId);
    if (!kb) throw new Error('Knowledge base not found');

    try {
      kb.status = 'processing';
      await kb.save();

      console.log(`[RAG] Processing KB: ${kb.name} (${kb.content.length} chars)`);

      // 1. Chunk the text
      const chunks = this.chunkText(kb.content);
      console.log(`[RAG] Created ${chunks.length} chunks`);

      // 2. Generate metadata + embeddings for each chunk (parallel, max 5 at a time)
      const processedChunks = [];
      const batchSize = 5;

      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        
        // Generate metadata for batch
        const metadataResults = await Promise.all(
          batch.map(async (chunk) => {
            const metadata = await this.generateChunkMetadata(chunk.text);
            return {
              text: chunk.text,
              index: chunk.index,
              summary: metadata.summary,
              keywords: metadata.keywords,
            };
          })
        );

        // Generate embeddings for batch texts
        const batchTexts = metadataResults.map(c => c.text);
        const embeddings = await this.generateEmbeddings(batchTexts);

        // Combine metadata with embeddings
        const enrichedResults = metadataResults.map((chunk, idx) => ({
          ...chunk,
          embedding: embeddings[idx] || [],
        }));

        processedChunks.push(...enrichedResults);
        console.log(`[RAG] Processed ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks (with embeddings)`);
      }

      // 3. Save chunks to KB
      kb.chunks = processedChunks;
      kb.totalChunks = processedChunks.length;
      kb.status = 'ready';
      kb.errorMessage = '';
      kb.hasEmbeddings = true; // Flag to enable semantic search
      await kb.save();

      console.log(`[RAG] KB ready: ${kb.name} — ${processedChunks.length} chunks with embeddings`);
      return kb;
    } catch (error) {
      kb.status = 'error';
      kb.errorMessage = error.message;
      await kb.save();
      console.error(`[RAG] Processing failed for ${kb.name}:`, error.message);
      throw error;
    }
  }

  /**
   * Search for relevant chunks matching a query
   * Uses keyword matching + optional Groq reranking
   * 
   * @param {string} query - User's question
   * @param {string} knowledgeBaseId - KB to search in
   * @param {number} topK - Number of chunks to return
   * @returns {Array<{text: string, score: number, summary: string}>}
   */
  async searchRelevantChunks(query, knowledgeBaseId, topK = 3) {
    const kb = await KnowledgeBase.findById(knowledgeBaseId);
    if (!kb || kb.status !== 'ready' || !kb.chunks || kb.chunks.length === 0) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\W+/).filter(w => w.length > 2);

    // Score each chunk by keyword overlap
    const scoredChunks = kb.chunks.map(chunk => {
      let score = 0;
      const chunkLower = chunk.text.toLowerCase();
      const chunkKeywords = (chunk.keywords || []).map(k => k.toLowerCase());

      // Direct text match (highest weight)
      queryWords.forEach(word => {
        if (chunkLower.includes(word)) score += 2;
        if (chunkKeywords.includes(word)) score += 3;
      });

      // Partial keyword overlap
      chunkKeywords.forEach(keyword => {
        if (queryLower.includes(keyword)) score += 2;
      });

      // Summary match
      if (chunk.summary) {
        const summaryLower = chunk.summary.toLowerCase();
        queryWords.forEach(word => {
          if (summaryLower.includes(word)) score += 1;
        });
      }

      return { ...chunk.toObject ? chunk.toObject() : chunk, score };
    });

    // Sort by score, take top K
    const topChunks = scoredChunks
      .filter(c => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // If we got results, optionally rerank with Groq for better quality
    const disableRerank = String(process.env.RAG_DISABLE_RERANK || 'false').toLowerCase() === 'true';
    const minWordsForRerank = Number(process.env.RAG_MIN_WORDS_FOR_RERANK || 4);
    if (!disableRerank && queryWords.length >= minWordsForRerank && topChunks.length > 1 && topChunks.length <= 5) {
      try {
        return await this.rerankWithGroq(query, topChunks, topK);
      } catch (e) {
        // Fallback to keyword-ranked results
        return topChunks;
      }
    }

    return topChunks;
  }

  /**
   * Rerank chunks using Groq LLM for better relevance
   */
  async rerankWithGroq(query, chunks, topK) {
    const chunksText = chunks.map((c, i) => `[${i}] ${c.text.substring(0, 300)}`).join('\n\n');

    const response = await groqService.generateResponse({
      messages: [
        {
          role: 'system',
          content: 'Given a query and text chunks, rank them by relevance. Respond ONLY with a JSON array of chunk indices in order of relevance, e.g. [2,0,1]. Nothing else.',
        },
        {
          role: 'user',
          content: `Query: ${query}\n\nChunks:\n${chunksText}`,
        },
      ],
      model: 'llama-3.1-8b-instant',
      temperature: 0,
    });

    const cleanJson = response.text.replace(/```json|```/g, '').trim();
    const ranking = JSON.parse(cleanJson);

    if (Array.isArray(ranking)) {
      return ranking
        .filter(i => i >= 0 && i < chunks.length)
        .slice(0, topK)
        .map(i => chunks[i]);
    }

    return chunks.slice(0, topK);
  }

  /**
   * Extract text from a PDF buffer
   * Robust implementation with fallback
   */
  async extractTextFromPDF(buffer) {
    // Try Approach 1: pdf-parse (Fastest)
    try {
      const data = await pdfParse(buffer);
      if (data && data.text && data.text.trim().length > 0) {
        return data.text;
      }
    } catch (e) {
      console.warn('pdf-parse failed, trying robust fallback:', e.message);
    }

    // Try Approach 2: pdfjs-dist (More robust for corrupted/complex PDFs)
    try {
      const uint8Array = new Uint8Array(buffer);
      const loadingTask = pdfjsLib.getDocument({
        data: uint8Array,
        disableFontFace: true,
        ignoreErrors: true, // Try to bypass some errors
      });
      
      const pdf = await loadingTask.promise;
      let fullText = '';
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map(item => item.str).join(' ');
        fullText += pageText + '\n\n';
      }
      
      if (fullText.trim().length > 0) {
        console.log('[RAG] Successfully extracted text using robust fallback');
        return fullText;
      }
    } catch (e) {
      console.error('Robust PDF extraction failed:', e.message);
      
      if (e.message.includes('XRef') || e.message.includes('corrupt')) {
        throw new Error('The PDF file is severely corrupted or encrypted. Please try a different file.');
      }
      throw new Error(`Failed to parse PDF: ${e.message}`);
    }

    throw new Error('Could not extract any text from this PDF.');
  }

  /**
   * Scrape text content from a URL
   */
  async scrapeUrl(url) {
    try {
      const fetch = require('node-fetch');
      const response = await fetch(url, {
        headers: { 'User-Agent': 'VaaniAI-Bot/1.0' },
        timeout: 15000,
      });
      
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const html = await response.text();
      
      // Basic HTML to text conversion
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      
      return text;
    } catch (e) {
      throw new Error(`Failed to scrape URL: ${e.message}`);
    }
  }

  /**
   * Get context string for system prompt injection
   * Called during live calls to augment agent's knowledge
   * Enhanced: Uses hybrid search when embeddings are available
   */
  async getContextForQuery(query, knowledgeBaseIds) {
    if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) return '';
    const minChars = Number(process.env.RAG_MIN_QUERY_CHARS || 12);
    const cacheTtlMs = Number(process.env.RAG_CONTEXT_CACHE_TTL_MS || 15000);
    const normalizedQuery = (query || '').trim().toLowerCase();
    if (!normalizedQuery || normalizedQuery.length < minChars) return '';

    // Sort IDs so cache key is deterministic
    const kbIdsStr = [...knowledgeBaseIds].sort().join(',');
    const cacheKey = `${kbIdsStr}:${normalizedQuery}`;
    const cached = this.contextCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < cacheTtlMs) {
      return cached.value;
    }

    try {
      const topK = Number(process.env.RAG_TOP_K || 3);
      
      const allChunksPromises = knowledgeBaseIds.map(async (kbId) => {
        const kb = await KnowledgeBase.findById(kbId);
        if (kb && kb.hasEmbeddings) {
          return this.hybridSearch(normalizedQuery, kbId, topK);
        } else if (kb) {
          return this.searchRelevantChunks(normalizedQuery, kbId, topK);
        }
        return [];
      });

      const chunkArrays = await Promise.all(allChunksPromises);
      let allChunks = chunkArrays.flat();
      
      const uniqueChunks = [];
      const seenTexts = new Set();
      for (const c of allChunks) {
        if (!seenTexts.has(c.text)) {
          seenTexts.add(c.text);
          uniqueChunks.push(c);
        }
      }

      uniqueChunks.sort((a, b) => b.score - a.score);
      const chunks = uniqueChunks.slice(0, topK);

      if (chunks.length === 0) return '';

      const contextStr = chunks
        .map((c, i) => `[Source ${i + 1}]: ${c.text}`)
        .join('\n\n');

      const value = `\n[Knowledge Base Context — Use this information to answer the user's questions accurately]:\n${contextStr}\n`;
      this.contextCache.set(cacheKey, { value, ts: Date.now() });
      return value;
    } catch (e) {
      console.error('RAG context error:', e.message);
      return '';
    }
  }
}

module.exports = new RAGService();
