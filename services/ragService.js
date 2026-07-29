/**
 * RAG Service — Production-Grade (Vapi/Retell Level)
 *
 * Upgrade log vs previous version:
 * ──────────────────────────────────────────────────
 * [NEW] In-Memory KB Cache   — embeddings stay in RAM, no MongoDB I/O per query
 * [NEW] HyDE                 — Hypothetical Document Embedding for better recall
 * [NEW] MMR Diversity        — Maximal Marginal Relevance prevents duplicate chunks
 * [NEW] Reciprocal Rank Fusion — properly merges keyword + semantic rankings
 * [NEW] Semantic Chunking    — paragraph / sentence-boundary aware splitting
 * [NEW] STT Preprocessing    — fixes "card loan" → "car loan" mishears
 * [KEPT] Hybrid search       — keyword + cosine similarity
 * [KEPT] LRU context cache   — bounded, TTL-based
 * [KEPT] Async reranking     — non-blocking Groq rerank for next-turn warm
 * [KEPT] SSRF protection     — URL scraping blocked on private IPs
 * [KEPT] PDF extraction      — dual fallback (pdf-parse → pdfjs-dist)
 * [FIXED] KB metadata        — Gemini PRIMARY (free), Groq fallback, inter-batch throttle
 */

const groqService       = require('./groqService');
const geminiService     = require('./geminiService');
const openRouterService = require('./openRouterService');
const KnowledgeBase     = require('../models/KnowledgeBase');
const pdfParse          = require('pdf-parse');

if (typeof global.DOMMatrix === 'undefined') global.DOMMatrix = class DOMMatrix {};
if (typeof global.Path2D    === 'undefined') global.Path2D    = class Path2D {};
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

class RAGService {
  constructor() {
    this.contextCache         = new Map();
    this._contextCacheMaxSize = Number(process.env.RAG_CONTEXT_CACHE_MAX_SIZE || 500);
    // In-Memory KB Cache: Map<kbId, {kb, loadedAt}>
    this._kbCache        = new Map();
    this._kbCacheTtlMs   = Number(process.env.RAG_KB_CACHE_TTL_MS  || 300000); // 5 min
    this._kbCacheMaxSize = Number(process.env.RAG_KB_CACHE_MAX_SIZE || 20);
  }

  // ── In-Memory KB Cache ─────────────────────────────────────────────
  async _loadKB(kbId) {
    const hit = this._kbCache.get(String(kbId));
    if (hit && Date.now() - hit.loadedAt < this._kbCacheTtlMs) return hit.kb;
    const kb = await KnowledgeBase.findById(kbId).lean();
    if (!kb) return null;
    if (this._kbCache.size >= this._kbCacheMaxSize) {
      this._kbCache.delete(this._kbCache.keys().next().value);
    }
    this._kbCache.set(String(kbId), { kb, loadedAt: Date.now() });
    return kb;
  }
  _invalidateKBCache(kbId) { this._kbCache.delete(String(kbId)); }

  // ── Embeddings ─────────────────────────────────────────────────────
  async generateEmbedding(text) {
    if (!geminiService.isEnabled || !geminiService.isEnabled()) return null;
    try { return await geminiService.generateEmbedding(text); }
    catch (e) { console.error('[RAG] Embedding failed:', e.message); return null; }
  }
  async generateEmbeddings(texts) {
    if (!geminiService.isEnabled || !geminiService.isEnabled()) return texts.map(() => []);
    try { return await geminiService.generateEmbeddings(texts); }
    catch (e) {
      console.error('[RAG] Batch embedding failed, sequential fallback:', e.message);
      const results = [];
      for (const text of texts) results.push((await this.generateEmbedding(text)) || []);
      return results;
    }
  }

  // ── Vector Math ────────────────────────────────────────────────────
  cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  // ── STT Preprocessing ──────────────────────────────────────────────
  _preprocessSttQuery(query) {
    let q = query || '';
    const hasCardCtx = /\b(credit|debit|swipe|atm|pin|cvv|\u0915\u094d\u0930\u0947\u0921\u093f\u091f|\u0921\u0947\u092c\u093f\u091f)\b/i.test(q);
    if (!hasCardCtx) {
      q = q.replace(/\bcard\s+loan\b/gi, 'car loan');
      q = q.replace(/\bcard\s+\u0932\u094b\u0928\b/gi, 'car \u0932\u094b\u0928');
    }
    q = q.replace(/\blone\b/gi, 'loan');
    return q;
  }

  // ── HyDE: Hypothetical Document Embedding ─────────────────────────
  async _hydeExpand(query) {
    const enabled = String(process.env.RAG_HYDE_ENABLED || 'true').toLowerCase() === 'true';
    if (!enabled || !geminiService.isEnabled || !geminiService.isEnabled()) return query;
    try {
      const r = await geminiService.generateResponse({
        messages: [
          { role: 'system', content: 'Answer the question in 1-2 short sentences as if you know the answer. Be concise.' },
          { role: 'user', content: query },
        ],
        model: 'gemini-2.0-flash-lite',
        temperature: 0.1,
      });
      const hypo = (r.text || '').trim();
      if (hypo && hypo.length > 10) return `${query}\n${hypo}`;
    } catch (_) {}
    return query;
  }

  // ── MMR: Maximal Marginal Relevance ───────────────────────────────
  _mmrSelect(candidates, queryVector, topK, lambda = 0.6) {
    if (!candidates || candidates.length === 0) return [];
    if (!queryVector || queryVector.length === 0) return candidates.slice(0, topK);
    const selected = [];
    const remaining = [...candidates];
    while (selected.length < topK && remaining.length > 0) {
      let bestIdx = 0, bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const relScore = remaining[i].semanticScore || 0;
        let maxSim = 0;
        for (const sel of selected) {
          const sim = (remaining[i].embedding && sel.embedding)
            ? this.cosineSimilarity(remaining[i].embedding, sel.embedding) : 0;
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = lambda * relScore - (1 - lambda) * maxSim;
        if (mmr > bestScore) { bestScore = mmr; bestIdx = i; }
      }
      selected.push(remaining[bestIdx]);
      remaining.splice(bestIdx, 1);
    }
    return selected;
  }

  // ── Reciprocal Rank Fusion ─────────────────────────────────────────
  _rrfMerge(listA, listB, k = 60) {
    const scores = new Map();
    const chunks  = new Map();
    const addRank = (list) => {
      list.forEach((chunk, rank) => {
        const id = chunk.text;
        scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1));
        if (!chunks.has(id)) chunks.set(id, chunk);
      });
    };
    addRank(listA);
    addRank(listB);
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, s]) => ({ ...chunks.get(id), score: s }));
  }

  // ── Semantic / Paragraph-aware Chunking ───────────────────────────
  chunkText(text, chunkSize = 600, overlap = 120) {
    if (!text || text.length === 0) return [];
    const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
    const paragraphs = clean.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 20);
    const rawChunks = [];
    let buffer = '';
    for (const para of paragraphs) {
      if (buffer.length + para.length + 2 <= chunkSize) {
        buffer = buffer ? `${buffer}\n\n${para}` : para;
      } else {
        if (buffer) rawChunks.push(buffer);
        if (para.length <= chunkSize) {
          buffer = para;
        } else {
          const sentences = para.match(/[^.!?]+[.!?]+(\s|$)/g) || [para];
          let sb = '';
          for (const s of sentences) {
            if (sb.length + s.length <= chunkSize) { sb += s; }
            else { if (sb) rawChunks.push(sb.trim()); sb = s; }
          }
          buffer = sb;
        }
      }
    }
    if (buffer) rawChunks.push(buffer);
    return rawChunks.map((t, i) => {
      let ct = t.trim();
      if (overlap > 0 && i > 0) {
        const tail = rawChunks[i-1].slice(-overlap).trim();
        if (tail.length >= 20) ct = `\u2026${tail}\n${ct}`;
      }
      return { text: ct, index: i };
    }).filter(c => c.text.length > 30);
  }

  // ── Keyword Search (BM25-inspired) ────────────────────────────────
  _keywordSearch(query, chunks, topK) {
    const qLower = query.toLowerCase();
    const qWords = qLower.split(/\W+/).filter(w => w.length > 2);
    const scored = chunks.map(chunk => {
      let score = 0;
      const cLower = chunk.text.toLowerCase();
      const cKws   = (chunk.keywords || []).map(k => k.toLowerCase());
      qWords.forEach(w => {
        const occ = (cLower.match(new RegExp(w, 'g')) || []).length;
        if (occ > 0) score += Math.min(occ, 3) * 2;
        if (cKws.includes(w)) score += 3;
      });
      cKws.forEach(kw => { if (qLower.includes(kw) && kw.length > 3) score += 2; });
      if (chunk.summary) {
        const sLow = chunk.summary.toLowerCase();
        qWords.forEach(w => { if (sLow.includes(w)) score += 1; });
      }
      return { ...chunk, score, keywordScore: score, semanticScore: 0 };
    });
    return scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK * 2);
  }

  // ── Full Hybrid Search: RRF + MMR ─────────────────────────────────
  async hybridSearch(query, knowledgeBaseId, topK = 3) {
    const kb = await this._loadKB(knowledgeBaseId);
    if (!kb || kb.status !== 'ready' || !kb.chunks || kb.chunks.length === 0) return [];
    const mmrLambda     = Number(process.env.RAG_MMR_LAMBDA || 0.6);
    const keywordRanked = this._keywordSearch(query, kb.chunks, topK);
    let semanticRanked  = [];
    let queryVector     = null;
    if (kb.hasEmbeddings) {
      const hydeQuery = await this._hydeExpand(query);
      queryVector     = await this.generateEmbedding(hydeQuery);
      if (queryVector) {
        const withSim = kb.chunks.map(c => ({
          ...c,
          semanticScore: (c.embedding && Array.isArray(c.embedding))
            ? this.cosineSimilarity(queryVector, c.embedding) : 0,
          keywordScore: 0, score: 0,
        }));
        semanticRanked = withSim.filter(c => c.semanticScore > 0.1)
          .sort((a, b) => b.semanticScore - a.semanticScore).slice(0, topK * 2);
      }
    }
    const merged   = semanticRanked.length > 0 ? this._rrfMerge(keywordRanked, semanticRanked) : keywordRanked;
    if (merged.length === 0) return [];
    return this._mmrSelect(merged, queryVector, topK, mmrLambda);
  }

  // ── Keyword-only Fallback ──────────────────────────────────────────
  async searchRelevantChunks(query, knowledgeBaseId, topK = 3) {
    const kb = await this._loadKB(knowledgeBaseId);
    if (!kb || kb.status !== 'ready' || !kb.chunks || kb.chunks.length === 0) return [];
    const topChunks   = this._keywordSearch(query, kb.chunks, topK).slice(0, topK);
    const qLower      = query.toLowerCase();
    const qWords      = qLower.split(/\W+/).filter(w => w.length > 2);
    const disableRnk  = String(process.env.RAG_DISABLE_RERANK || 'false').toLowerCase() === 'true';
    const minWords    = Number(process.env.RAG_MIN_WORDS_FOR_RERANK || 4);
    if (!disableRnk && qWords.length >= minWords && topChunks.length > 1) {
      const cacheUpdateKey = `${knowledgeBaseId}:${qLower}`;
      this.rerankWithGroq(query, topChunks, topK)
        .then(reranked => {
          if (reranked && reranked.length > 0) {
            const ctx   = reranked.map((c, i) => `[Source ${i+1}]: ${c.text}`).join('\n\n');
            const value = `\n[Knowledge Base Context]:\n${ctx}\n`;
            const ttl   = Number(process.env.RAG_CONTEXT_CACHE_TTL_MS || 15000);
            this.contextCache.set(cacheUpdateKey, { value, ts: Date.now() - (ttl / 2) });
          }
        }).catch(() => {});
    }
    return topChunks;
  }

  // ── Reranker (async, non-blocking) ───────────────────────────
  async rerankWithGroq(query, chunks, topK) {
    const chunksText = chunks.map((c, i) => `[${i}] ${c.text.substring(0, 300)}`).join('\n\n');
    const msgs = [
      { role: 'system', content: 'Rank chunks by relevance to the query. Respond ONLY with a JSON array of indices, e.g. [2,0,1].' },
      { role: 'user',   content: `Query: ${query}\n\nChunks:\n${chunksText}` },
    ];
    
    let responseText = null;
    
    // Try OpenRouter first (paid, reliable)
    if (openRouterService.isEnabled() && openRouterService.isAvailable()) {
        try {
            responseText = (await openRouterService.generateResponse({ messages: msgs, model: 'meta-llama/llama-3.1-8b-instruct', temperature: 0 })).text;
        } catch (e) { console.warn('[RAG] OpenRouter rerank failed:', e.message); }
    }
    
    // Fallback to Groq
    if (!responseText) {
        try {
            responseText = (await groqService.generateResponse({ messages: msgs, model: 'llama-3.1-8b-instant', temperature: 0 })).text;
        } catch (e) { console.warn('[RAG] Groq rerank failed:', e.message); }
    }

    if (responseText) {
        try {
            const ranking = JSON.parse(responseText.replace(/```json|```/g, '').trim());
            if (Array.isArray(ranking)) return ranking.filter(i => i >= 0 && i < chunks.length).slice(0, topK).map(i => chunks[i]);
        } catch(e) {}
    }
    
    return chunks.slice(0, topK);
  }

  // ── KB Metadata Generation (OpenRouter PRIMARY) ───────────────────────
  async generateChunkMetadata(chunkText) {
    const input = chunkText.substring(0, 800);
    const msgs  = [
      { role: 'system', content: 'Extract keywords and a one-line summary. Respond ONLY with JSON: {"keywords":["word1"],"summary":"one line"}' },
      { role: 'user',   content: input },
    ];
    const parse = (t) => {
      const p = JSON.parse(t.replace(/```json|```/g, '').trim());
      return { keywords: p.keywords || [], summary: p.summary || '' };
    };

    // PRIMARY: OpenRouter (paid, no TPM wall)
    if (openRouterService.isEnabled() && openRouterService.isAvailable()) {
      try {
        return parse((await openRouterService.generateResponse({ messages: msgs, model: 'meta-llama/llama-3.1-8b-instruct', temperature: 0 })).text);
      } catch (e) { console.warn('[RAG] OpenRouter metadata failed:', e.message); }
    }

    // FALLBACK 1: Gemini
    if (geminiService.isEnabled && geminiService.isEnabled()) {
      try {
        return parse((await geminiService.generateResponse({ messages: msgs, model: 'gemini-2.0-flash-lite', temperature: 0 })).text);
      } catch (e) { console.warn('[RAG] Gemini metadata failed:', e.message); }
    }

    // FALLBACK 2: Groq
    try {
      return parse((await groqService.generateResponse({ messages: msgs, model: 'llama-3.1-8b-instant', temperature: 0 })).text);
    } catch (e) { console.warn('[RAG] Groq metadata failed:', e.message); }

    // Manual TF-IDF fallback
    const words = chunkText.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    const freq  = {};
    words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    return {
      keywords: Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0, 10).map(e => e[0]),
      summary: chunkText.substring(0, 100),
    };
  }

  // ── PDF Table-Merge Cleanup (Universal — works for ANY domain) ──────
  //
  // pdf-parse / pdfjs extract PDF table cells without column separators,
  // producing merged strings regardless of domain:
  //
  //   Banking:   "Takeover ConditionCar age ≤ 3 years"
  //   Medical:   "DosageTwice daily after meals"
  //   HR:        "Notice Period30 days"
  //   Legal:     "JurisdictionDelhi High Court"
  //   E-commerce:"Return Policy7 days from delivery"
  //
  // ROOT CAUSE: In a PDF table, each row has a Label column and a Value
  // column. When extracted linearly, the last character of the label and
  // the first character of the value are concatenated with NO space.
  //
  // UNIVERSAL HEURISTIC: In English/Hindi prose a lowercase letter is
  // NEVER immediately followed by an uppercase letter or a digit without
  // a space. If we see that pattern, it's a PDF column boundary → split.
  //
  // Exclusions handled:
  //   • URLs (https://...) — protected by URL guard
  //   • Known abbreviations (e.g., Ltd., etc., Mr., Dr.) — protected
  //   • Currency symbols and digits — caught by the ₹/$/%/digit rule
  //
  _cleanPdfContent(text) {
    if (!text) return text;
    let t = text;

    // ── Step 1: Remove repeated page headers / footers ──────────────
    // Generic patterns that appear in almost all formatted/corporate PDFs
    // regardless of domain: company name line, helpline footer, "Page N"
    t = t.replace(/[A-Za-z ,\.]{5,}Ltd\.[^\n]{0,80}Page \d+\s*/g, '\n');
    t = t.replace(/Helpline:[^\n]{0,80}Page \d+\s*/g, '\n');
    // Generic footer: "something | something | Page N"
    t = t.replace(/^[^\n]{5,60}\|\s*Page \d+\s*$/gm, '');
    t = t.replace(/^\s*Page \d+\s*$/gm, '');
    t = t.replace(/com\s*Page \d+/g, '');

    // ── Step 2: Remove boilerplate lines that repeat 3+ times ────────
    // Corporate PDFs often repeat the company name + contact on every page.
    // Any line appearing 3+ times is a header/footer → remove.
    const lines = t.split('\n');
    const freq = {};
    lines.forEach(l => {
      const k = l.trim();
      if (k.length > 8 && k.length < 130) freq[k] = (freq[k] || 0) + 1;
    });
    const boilerplate = new Set(Object.keys(freq).filter(k => freq[k] >= 3));
    if (boilerplate.size > 0) {
      t = lines.filter(l => !boilerplate.has(l.trim())).join('\n');
    }

    // ── Step 3: Universal table-cell boundary detection ──────────────
    // CORE HEURISTIC — works for ANY domain (Banking, Medical, HR, Legal,
    // E-commerce, Insurance, Education, etc.):
    //
    // In English/Hindi prose a lowercase letter is NEVER immediately
    // followed by an uppercase letter or digit WITHOUT a space.
    // When pdf-parse/pdfjs merges table columns that boundary is lost.
    // We restore it by inserting a newline at every such transition.
    //
    // Examples caught automatically, without any domain-specific list:
    //   Banking:    "Takeover ConditionCar age ≤ 3 yrs" → split at "nC"
    //   Medical:    "DosageTwice daily"                  → split at "eT"
    //   HR:         "Notice Period30 days"               → split at "d3"
    //   Legal:      "JurisdictionDelhi High Court"       → split at "nD"
    //   E-commerce: "Return Policy7 days"                → split at "y7"
    //   Insurance:  "Sum Assured₹5 lakh"                → split at "d₹"
    t = t.replace(
      /([a-z\u0900-\u097F])([A-Z\u20B9\u0024\u20AC\u00A3\u0025\u0900-\u097F\d])/g,
      (match, p1, p2, offset, str) => {
        // Guard 1: inside a URL → skip
        const ctx = str.substring(Math.max(0, offset - 25), offset + 1);
        if (/https?:\/\/\S*$/.test(ctx)) return match;
        // Guard 2: digit→digit is part of a number, not a boundary
        if (/\d/.test(p1) && /\d/.test(p2)) return match;
        // Guard 3: p2 is % directly after a digit (e.g. "12%" is fine)
        if (/\d/.test(p1) && p2 === '%') return match;
        return `${p1}\n${p2}`;
      }
    );

    // ── Step 4: Currency symbols still glued after Step 3 ────────────
    t = t.replace(/([a-zA-Z\u0900-\u097F)])(\u20B9|\$|€|£)/g, '$1\n$2');

    // ── Step 5: Normalise whitespace ─────────────────────────────────
    t = t.replace(/[ \t]{2,}/g, ' ');
    t = t.replace(/\r\n/g, '\n');
    t = t.replace(/\n{3,}/g, '\n\n');

    return t.trim();
  }

  // ── Document Processing ───────────────────────────────────────────
  async processDocument(knowledgeBaseId) {
    const kb = await KnowledgeBase.findById(knowledgeBaseId);
    if (!kb) throw new Error('Knowledge base not found');
    try {
      kb.status = 'processing';
      await kb.save();
      console.log(`[RAG] Processing KB: ${kb.name} (${kb.content.length} chars)`);
      // Clean PDF table-merge artifacts before chunking so every upload
      // automatically gets readable, searchable key-value pairs.
      const cleanedContent = this._cleanPdfContent(kb.content);
      if (cleanedContent.length !== kb.content.length) {
        console.log(`[RAG] Content cleaned: ${kb.content.length} → ${cleanedContent.length} chars`);
      }
      const chunks = this.chunkText(cleanedContent);
      console.log(`[RAG] Created ${chunks.length} semantic chunks`);
      const processedChunks = [];
      const batchSize       = 5;
      for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const metaResults = await Promise.all(
          batch.map(async (c) => {
            const m = await this.generateChunkMetadata(c.text);
            return { text: c.text, index: c.index, summary: m.summary, keywords: m.keywords };
          })
        );
        const embeddings = await this.generateEmbeddings(metaResults.map(c => c.text));
        processedChunks.push(...metaResults.map((c, idx) => ({ ...c, embedding: embeddings[idx] || [] })));
        console.log(`[RAG] Processed ${Math.min(i + batchSize, chunks.length)}/${chunks.length} chunks`);
        if (i + batchSize < chunks.length) await new Promise(r => setTimeout(r, 300));
      }
      kb.chunks        = processedChunks;
      kb.totalChunks   = processedChunks.length;
      kb.status        = 'ready';
      kb.errorMessage  = '';
      kb.hasEmbeddings = true;
      await kb.save();
      this._invalidateKBCache(knowledgeBaseId);
      console.log(`[RAG] KB ready: ${kb.name} — ${processedChunks.length} chunks`);
      return kb;
    } catch (err) {
      kb.status = 'error'; kb.errorMessage = err.message;
      await kb.save();
      console.error(`[RAG] Processing failed for ${kb.name}:`, err.message);
      throw err;
    }
  }

  // ── PDF Extraction ─────────────────────────────────────────────────
  async extractTextFromPDF(buffer) {
    try {
      const data = await pdfParse(buffer);
      if (data && data.text && data.text.trim().length > 0) return data.text;
    } catch (e) { console.warn('pdf-parse failed:', e.message); }
    try {
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), disableFontFace: true, ignoreErrors: true }).promise;
      let text  = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const content = await (await pdf.getPage(i)).getTextContent();
        text += content.items.map(x => x.str).join(' ') + '\n\n';
      }
      if (text.trim().length > 0) { console.log('[RAG] pdfjs fallback succeeded'); return text; }
    } catch (e) {
      if (e.message.includes('XRef') || e.message.includes('corrupt'))
        throw new Error('PDF is corrupted or encrypted.');
      throw new Error(`PDF parse failed: ${e.message}`);
    }
    throw new Error('Could not extract text from PDF.');
  }

  // ── URL Scraping (SSRF protected) ─────────────────────────────────
  async scrapeUrl(url) {
    try {
      const { URL } = require('url');
      const parsed  = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error(`SSRF blocked: only HTTP/HTTPS (got ${parsed.protocol})`);
      const blocked = [/^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[01])\./, /^192\.168\./,
        /^169\.254\./, /^0\.0\.0\.0$/, /^::1$/, /^fc00:/i, /^fe80:/i, /^localhost$/i, /^metadata\.google\.internal$/i];
      if (blocked.some(re => re.test(parsed.hostname)))
        throw new Error(`SSRF blocked: private host '${parsed.hostname}'`);
    } catch (e) {
      if (e.message.startsWith('SSRF')) throw new Error(`Failed to scrape URL: ${e.message}`);
      throw new Error(`Failed to scrape URL: Invalid URL — ${e.message}`);
    }
    try {
      const fetch = require('node-fetch');
      const res   = await fetch(url, { headers: { 'User-Agent': 'VaaniAI-Bot/1.0' }, timeout: 15000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html  = await res.text();
      return html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    } catch (e) { throw new Error(`Failed to scrape URL: ${e.message}`); }
  }

  // ── Main Entry Point ──────────────────────────────────────────────
  async getContextForQuery(query, knowledgeBaseIds) {
    if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) return '';
    const minChars   = Number(process.env.RAG_MIN_QUERY_CHARS || 12);
    const cacheTtlMs = Number(process.env.RAG_CONTEXT_CACHE_TTL_MS || 15000);
    const corrected  = this._preprocessSttQuery(query);
    const normalized = (corrected || '').trim().toLowerCase();
    if (!normalized || normalized.length < minChars) return '';
    const kbIdsStr = [...knowledgeBaseIds].sort().join(',');
    const cacheKey = `${kbIdsStr}:${normalized}`;
    const cached   = this.contextCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < cacheTtlMs) return cached.value;
    try {
      const topK = Number(process.env.RAG_TOP_K || 3);
      const allChunks = (await Promise.all(
        knowledgeBaseIds.map(async (kbId) => {
          const kb = await this._loadKB(kbId);
          if (!kb) return [];
          return kb.hasEmbeddings
            ? this.hybridSearch(normalized, kbId, topK)
            : this.searchRelevantChunks(normalized, kbId, topK);
        })
      )).flat();
      const seen  = new Set();
      const dedup = allChunks.filter(c => { if (seen.has(c.text)) return false; seen.add(c.text); return true; });
      dedup.sort((a, b) => (b.score || 0) - (a.score || 0));
      const final = dedup.slice(0, topK);
      if (final.length === 0) return '';
      const contextStr = final.map((c, i) => `[Source ${i+1}]: ${c.text}`).join('\n\n');
      const value = `\n[Knowledge Base Context — Use this information to answer the user'\''s questions accurately]:\n${contextStr}\n`;
      if (this.contextCache.size >= this._contextCacheMaxSize)
        this.contextCache.delete(this.contextCache.keys().next().value);
      this.contextCache.set(cacheKey, { value, ts: Date.now() });
      return value;
    } catch (e) { console.error('[RAG] getContextForQuery error:', e.message); return ''; }
  }
}

module.exports = new RAGService();
