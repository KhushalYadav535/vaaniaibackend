/**
 * Main Voice Pipeline Orchestrator
 * Flow: Audio Input → STT (Deepgram) → LLM (Groq) → TTS (Edge TTS) → Audio Output
 */
const groqService = require('./groqService');
const geminiService = require('./geminiService');
const ttsService = require('./ttsService');
const deepgramService = require('./deepgramService');
const toolExecutor = require('./toolExecutor');
const KnowledgeBase = require('../models/KnowledgeBase');

class VoicePipeline {
  constructor() {
    // LRU response cache for FAQ-type repeated queries
    this._responseCache = new Map();
    this._responseCacheMaxEntries = Number(process.env.LLM_RESPONSE_CACHE_MAX || 50);
    this._responseCacheEnabled = String(process.env.LLM_RESPONSE_CACHE_ENABLED || 'true').toLowerCase() === 'true';
    this._responseCacheTtlMs = Number(process.env.LLM_RESPONSE_CACHE_TTL_MS || 300000); // 5 min

    // Rolling summary settings
    this._summaryThreshold = Number(process.env.ROLLING_SUMMARY_THRESHOLD || 12); // summarize after N messages
    this._summaryKeepRecent = Number(process.env.ROLLING_SUMMARY_KEEP_RECENT || 6); // keep last N messages verbatim
  }

  getGroqFallbackModels(primaryModel = 'llama-3.1-8b-instant') {
    const envList = (process.env.GROQ_FALLBACK_MODELS || '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
    const defaults = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'mixtral-8x7b-32768'];
    const ordered = [primaryModel, ...envList, ...defaults];
    return [...new Set(ordered)];
  }

  async generateGroqResponseWithFallback({ messages, model, temperature, apiKey, tools = null }) {
    const candidates = this.getGroqFallbackModels(model);
    let lastError = null;

    for (const candidate of candidates) {
      try {
        return await groqService.generateResponse({
          messages,
          model: candidate,
          temperature,
          apiKey,
          tools,
        });
      } catch (err) {
        lastError = err;
        console.warn(`[LLM Fallback] Groq model failed: ${candidate} -> ${err.message}`);
      }
    }

    // ─── GEMINI FALLBACK: If ALL Groq models failed, try Gemini (free) ────
    if (geminiService.isAvailable()) {
      try {
        console.log('[LLM Fallback] All Groq models failed. Trying Gemini...');
        const geminiResp = await geminiService.generateResponse({ messages, temperature });
        console.log(`[LLM Fallback] Gemini success (${geminiResp.latencyMs}ms)`);
        return geminiResp;
      } catch (geminiErr) {
        console.error('[LLM Fallback] Gemini also failed:', geminiErr.message);
      }
    }

    throw lastError || new Error('all_llm_models_failed');
  }

  /**
   * Process a text input through LLM → TTS
   * Used when we already have transcribed text
   */
  async processText({ text, agent, history = [], userSettings = {}, memory = null, ragContext = '' }) {
    const start = Date.now();

    // Build conversation messages
    const messages = [
      {
        role: 'system',
        content: this.buildSystemPrompt(agent, memory, ragContext),
      },
      ...history.map(msg => ({
        role: msg.role,
        content: msg.content,
      })),
      {
        role: 'user',
        content: text,
      },
    ];

    // Determine which LLM to use
    const llmProvider = agent.llm?.provider || 'groq';
    const llmModel = agent.llm?.model || 'llama-3.1-8b-instant';
    const voiceProvider = agent.voice?.provider || 'edge-tts';
    const apiKey = userSettings[`${llmProvider}Key`] || process.env.GROQ_API_KEY;

    // Generate LLM response (supports tool calling loop)
    let finalResponseText = '';
    let totalLlmLatency = 0;
    let toolResults = [];

    // Format agent tools for Groq
    const groqTools = (agent.tools || []).map(t => ({
      type: 'function',
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters || { type: 'object', properties: {} },
      }
    }));

    // Up to 3 iterations for tool calls
    for (let iter = 0; iter < 3; iter++) {
      let llmResponse;
      if (agent.advanced?.customLlmUrl) {
        const axios = require('axios');
        try {
          const res = await axios.post(agent.advanced.customLlmUrl, { messages, agentId: agent._id });
          const text = typeof res.data === 'string' ? res.data : (res.data?.text || res.data?.response || JSON.stringify(res.data));
          llmResponse = { text, latencyMs: 200, toolCalls: [] };
        } catch (e) {
          llmResponse = { text: "Custom LLM failed.", latencyMs: 0, toolCalls: [] };
        }
      } else if (llmProvider === 'gemini') {
        // ─── Direct Gemini provider selection ─────────────────────────────
        llmResponse = await geminiService.generateResponse({
          messages,
          model: llmModel || 'gemini-1.5-flash',
          temperature: agent.temperature || 0.7,
          apiKey: userSettings.geminiKey || process.env.GEMINI_API_KEY,
        });
      } else {
        // ─── Default: Groq with Gemini auto-fallback ─────────────────────
        llmResponse = await this.generateGroqResponseWithFallback({
          messages,
          model: llmModel,
          temperature: agent.temperature || 0.7,
          apiKey: userSettings.groqKey || process.env.GROQ_API_KEY,
          tools: groqTools.length > 0 ? groqTools : null,
        });
      }

      totalLlmLatency += llmResponse.latencyMs;

      // Handle tool calls if present
      if (llmResponse.toolCalls && llmResponse.toolCalls.length > 0) {
        messages.push(llmResponse.message); // Append assistant's tool call message
        
        // Execute each tool (simulated webhook or internal function)
        for (const toolCall of llmResponse.toolCalls) {
          const fnName = toolCall.function.name;
          const fnArgs = toolCall.function.arguments;
          console.log(`[Tool execution] Call: ${fnName}(${fnArgs})`);
          
          let resultStr = '';
          try {
            const args = typeof fnArgs === 'string' ? JSON.parse(fnArgs) : fnArgs;
            const result = await toolExecutor.executeTool({ toolName: fnName, toolInput: args, agentContext: agent });
            resultStr = JSON.stringify(result);
          } catch (e) {
            resultStr = `{"status": "error", "message": "${e.message}"}`;
          }
          
          toolResults.push({ name: fnName, args: fnArgs, result: resultStr });
          
          // Append tool response
          messages.push({
            role: 'tool',
            content: resultStr,
            tool_call_id: toolCall.id,
          });
        }
        // Loop continues to generate the next response based on tool output
      } else {
        // No more tool calls, we have our final text
        finalResponseText = llmResponse.text;
        break;
      }
    }

    const responseText = finalResponseText;
    const llmLatencyMs = totalLlmLatency;

    // Convert to speech
    const lang = agent.language || 'en';
    let defaultVoiceId = 'en-US-JennyNeural';
    if (lang === 'hi' || lang === 'hi-Latn' || lang === 'multi') defaultVoiceId = 'hi-IN-SwaraNeural';
    else if (lang === 'ta') defaultVoiceId = 'ta-IN-PallaviNeural';
    else if (lang === 'te') defaultVoiceId = 'te-IN-ShrutiNeural';
    else if (lang === 'kn') defaultVoiceId = 'kn-IN-SapnaNeural';
    else if (lang === 'ml') defaultVoiceId = 'ml-IN-SobhanaNeural';
    else if (lang === 'mr') defaultVoiceId = 'mr-IN-AarohiNeural';
    else if (lang === 'gu') defaultVoiceId = 'gu-IN-DhwaniNeural';
    else if (lang === 'bn') defaultVoiceId = 'bn-IN-TanishaaNeural';
    else if (lang === 'ur') defaultVoiceId = 'ur-IN-GulNeural';
    else if (lang === 'pa') defaultVoiceId = 'pa-IN-OjasNeural';
    else if (lang === 'en-IN') defaultVoiceId = 'en-IN-NeerjaNeural';

    const voiceId = agent.voice?.voiceId || defaultVoiceId;
    const speed = agent.voice?.speed || 1.0;

    let audioBuffer;
    try {
      audioBuffer = await ttsService.textToSpeech({
        text: responseText,
        voiceId,
        speed,
        provider: voiceProvider,
      });
    } catch (ttsError) {
      console.error('TTS failed:', ttsError.message);
      audioBuffer = Buffer.alloc(0);
    }

    const totalLatencyMs = Date.now() - start;

    return {
      transcript: text,         // What user said
      response: responseText,   // What AI said
      audioBuffer,              // Audio bytes (MP3)
      latency: {
        llm: llmLatencyMs,
        total: totalLatencyMs,
      },
    };
  }

  /**
   * Fast real-time emotion detection based on transcript
   */
  detectEmotion(text) {
    const lower = text.toLowerCase();
    if (/(angry|frustrat|cancel|terrible|worst|hate|stupid|idiot|useless|refund)/i.test(lower)) return 'angry';
    if (/(happy|great|awesome|thanks|thank you|love|excellent|perfect)/i.test(lower)) return 'happy';
    if (/(sad|sorry|crying|depress|unfortunately)/i.test(lower)) return 'sad';
    if (/(urgent|emergency|help me now|immediately|asap)/i.test(lower)) return 'urgent';
    return 'neutral';
  }

  /**
   * Process text with full streaming (LLM tokens -> Sentence chunks -> TTS)
   *
   * CONCURRENT PIPELINE: LLM token stream is consumed without ever blocking on TTS.
   * Each complete sentence immediately fires a TTS Promise that is pushed into an
   * ordered array (ttsQueue). A separate drainer yields results in insertion order.
   *
   * Old sequential timeline:  LLM[s1] ──wait──> TTS[s1] ──wait──> LLM[s2] ──wait──> TTS[s2]
   * New concurrent timeline:  LLM[s1,s2,s3...] runs concurrently with TTS[s1] TTS[s2] TTS[s3]
   *
   * Result: First audio arrives ~500ms instead of ~1000ms.
   */
  async *processTextStream({ text, agent, history = [], userSettings = {}, memory = null, ragContext = '' }) {
    // ── Emotion detection ──────────────────────────────────────────────────
    const currentEmotion = this.detectEmotion(text);
    let emotionPrompt = '';
    if (currentEmotion === 'angry')  emotionPrompt = '\n[SYSTEM DIRECTIVE]: The user seems frustrated or angry. Adopt a highly empathetic, calming, and apologetic tone immediately.';
    if (currentEmotion === 'urgent') emotionPrompt = '\n[SYSTEM DIRECTIVE]: The user has an urgent issue. Be extremely concise, fast, and helpful. Get straight to the point.';

    // ── Rolling conversation summary for long calls ──────────────────────
    const { summary: rollingSummary, recentHistory } = await this.compressHistory(history);
    let summaryPrompt = '';
    if (rollingSummary) {
      summaryPrompt = `\n\n## EARLIER CONVERSATION SUMMARY:\n${rollingSummary}`;
    }

    const messages = [
      { role: 'system', content: this.buildSystemPrompt(agent, memory, ragContext) + summaryPrompt + emotionPrompt },
      ...recentHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: text },
    ];

    const llmProvider   = agent.llm?.provider   || 'groq';
    const llmModel      = agent.llm?.model       || 'llama-3.1-8b-instant';
    const voiceProvider = agent.voice?.provider  || 'edge-tts';
    const voiceId       = agent.voice?.voiceId   || 'en-US-JennyNeural';
    const speed         = agent.voice?.speed     || 1.0;
    const ttsApiKey     = userSettings.ttsKey    || process.env.ELEVENLABS_API_KEY;

    const fastFirstChunkMode       = String(process.env.FAST_FIRST_CHUNK_MODE || 'true').toLowerCase() === 'true';
    const firstChunkCharThreshold  = Number(process.env.FAST_FIRST_CHUNK_CHAR_THRESHOLD || 36);
    const firstChunkMaxWords       = Number(process.env.FAST_FIRST_CHUNK_MAX_WORDS || 8);

    // ── Dynamic Knowledge (RAG 2.0) ────────────────────────────────────────
    let dynamicKnowledge = '';
    if (agent.knowledgeBaseId) {
      const kb = await KnowledgeBase.findById(agent.knowledgeBaseId);
      if (kb) {
        dynamicKnowledge = `\n[Dynamic Knowledge Context]:\n${kb.content.substring(0, 1000)}`;
      }
    }

    // ── Tool instructions ──────────────────────────────────────────────────
    const toolInstructions = agent.webhooks?.length > 0
      ? `\n[Tool Instructions]: You can call these tools if needed: ${agent.webhooks.map(w => w.name).join(', ')}. Format: <TOOL>function_name(args)</TOOL>`
      : '';

    const systemPrompt = this.buildSystemPrompt(agent, memory, ragContext) + dynamicKnowledge + toolInstructions + emotionPrompt;
    messages[0].content = systemPrompt;

    // ── Filler word (fires synchronously before stream to reduce TTFA) ─────
    if (agent.advanced?.fillerWords && Math.random() < 0.35) {
      const fillers = ['Hmm...', 'Let me see...', 'Umm...', 'Okay...', 'Well...'];
      const filler  = fillers[Math.floor(Math.random() * fillers.length)];
      const fillerAudio = await ttsService.textToSpeech({ text: filler, voiceId, speed, apiKey: ttsApiKey, provider: voiceProvider });
      yield { type: 'chunk', text: filler + ' ', audio: fillerAudio };
    }

    // ── Select token stream (Custom URL or Groq with fallback) ────────────
    let tokenStream;
    if (agent.advanced?.customLlmUrl) {
      tokenStream = (async function* () {
        const axios = require('axios');
        try {
          const res  = await axios.post(agent.advanced.customLlmUrl, { messages, agentId: agent._id });
          const body = typeof res.data === 'string' ? res.data : (res.data?.text || res.data?.response || JSON.stringify(res.data));
          for (const w of body.split(' ')) yield w + ' ';
        } catch (e) {
          console.error('Custom LLM Webhook failed:', e.message);
          yield 'Sorry, my external intelligence server is offline.';
        }
      })();
    } else if (llmProvider === 'gemini' && geminiService.isAvailable(userSettings.geminiKey)) {
      // ─── Direct Gemini streaming ─────────────────────────────────────
      tokenStream = geminiService.generateStreamResponse({
        messages,
        model: llmModel || 'gemini-1.5-flash',
        temperature: agent.temperature || 0.7,
        apiKey: userSettings.geminiKey || process.env.GEMINI_API_KEY,
      });
    } else {
      const candidateModels = this.getGroqFallbackModels(llmModel);
      let streamCreated = false;
      let lastErr = null;
      for (const modelCandidate of candidateModels) {
        try {
          tokenStream   = groqService.generateStreamResponse({
            messages,
            model:       modelCandidate,
            temperature: agent.temperature || 0.7,
            apiKey:      userSettings[`${llmProvider}Key`] || process.env.GROQ_API_KEY,
          });
          streamCreated = true;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[LLM Stream Fallback] ${modelCandidate} failed -> ${err.message}`);
        }
      }
      // ─── Gemini auto-fallback for streaming ───────────────────────────
      if (!streamCreated && geminiService.isAvailable()) {
        console.log('[LLM Stream Fallback] All Groq models failed. Trying Gemini stream...');
        tokenStream = geminiService.generateStreamResponse({ messages, temperature: agent.temperature || 0.7 });
        streamCreated = true;
      }
      if (!streamCreated) throw lastErr || new Error('all_llm_stream_models_failed');
    }

    // ═════════════════════════════════════════════════════════════════════
    // CONCURRENT PIPELINE CORE
    // ─────────────────────────────────────────────────────────────────────
    // ttsQueue  : Array<Promise<{text, audio}>>  — ordered TTS jobs
    // producerDone: boolean — signals that the LLM loop has finished
    // producerError: Error|null — any error from the producer
    // ─────────────────────────────────────────────────────────────────────

    /** Helper: kick off TTS without blocking; returns a Promise<{text,audio}> */
    const fireTTS = (sentenceText) =>
      ttsService.textToSpeech({ text: sentenceText, voiceId, speed, apiKey: ttsApiKey, provider: voiceProvider })
        .then(audio => ({ text: sentenceText, audio }))
        .catch(err  => {
          console.error(`[TTS Concurrent] Failed: "${sentenceText.substring(0, 40)}"`, err.message);
          return { text: sentenceText, audio: Buffer.alloc(0) };
        });

    const ttsQueue     = [];   // ordered promise array
    let producerDone   = false;
    let producerError  = null;
    let fullResponseText = '';

    // ── LLM Producer (runs concurrently; never awaits TTS) ────────────────
    const runProducer = async () => {
      let currentSentence     = '';
      let hasSpokenFirstChunk = false;

      try {
        for await (const token of tokenStream) {
          fullResponseText  += token;
          currentSentence   += token;

          // ── Tool Execution (Vapi/Retell style) ──────────────────────────
          if (fullResponseText.includes('<TOOL>') && fullResponseText.includes('</TOOL>')) {
            const toolMatch = fullResponseText.match(/<TOOL>(.*?)<\/TOOL>/);
            if (toolMatch) {
              const toolCallStr = toolMatch[1];
              const name        = toolCallStr.split('(')[0];
              const argsStr     = toolCallStr.match(/\((.*?)\)/)?.[1] || '{}';
              try {
                const args       = JSON.parse(argsStr.replace(/'/g, '"'));
                const toolResult = await toolExecutor.executeTool({ toolName: name, toolInput: args, agentContext: agent });

                if (toolResult.result?.__transferToAgentId) {
                  // Enqueue a special sentinel so the drainer can yield the transfer event
                  ttsQueue.push(Promise.resolve({
                    __special: 'transfer_agent',
                    agentId:   toolResult.result.__transferToAgentId,
                    reason:    toolResult.result.reason,
                  }));
                  return; // Stop producing
                }

                console.log('[Tool Executed] Result:', toolResult);
                fullResponseText = fullResponseText.replace(toolMatch[0], ` [Result: ${JSON.stringify(toolResult)}] `);
              } catch (e) {
                console.error('Tool parsing failed:', e.message);
              }
            }
          }

          // ── Fast-first-chunk: fire TTS before sentence boundary ─────────
          if (fastFirstChunkMode && !hasSpokenFirstChunk && currentSentence.trim().length >= firstChunkCharThreshold) {
            const words          = currentSentence.trim().split(/\s+/).filter(Boolean);
            const firstChunkText = words.slice(0, firstChunkMaxWords).join(' ').trim();
            const remainder      = words.slice(firstChunkMaxWords).join(' ').trim();

            if (firstChunkText.length > 0) {
              ttsQueue.push(fireTTS(firstChunkText)); // fire immediately, don't await
              hasSpokenFirstChunk = true;
              currentSentence     = remainder ? `${remainder} ` : '';
              console.log(`[Pipeline] Fast-chunk TTS fired (queue=${ttsQueue.length}): "${firstChunkText.substring(0, 50)}"`);
            }
          }

          // ── Sentence boundary detected ──────────────────────────────────
          if (/[.!?\n]/.test(token) && currentSentence.trim().length > 5) {
            const sentenceToSpeak = currentSentence.trim();
            currentSentence = '';
            ttsQueue.push(fireTTS(sentenceToSpeak)); // fire immediately, don't await
            console.log(`[Pipeline] Sentence TTS fired (queue=${ttsQueue.length}): "${sentenceToSpeak.substring(0, 50)}"`);
          }
        }

        // Flush any trailing partial sentence
        if (currentSentence.trim().length > 0) {
          ttsQueue.push(fireTTS(currentSentence.trim()));
          console.log(`[Pipeline] Remainder TTS fired: "${currentSentence.trim().substring(0, 50)}"`);
        }
      } catch (err) {
        producerError = err;
      } finally {
        producerDone = true;
      }
    };

    // ── Start producer without awaiting it — it runs concurrently ─────────
    const producerPromise = runProducer();

    let hasEmittedAnyChunk = false;

    try {
      // ── Drainer: yield completed TTS jobs in order ──────────────────────
      // Poll the front of ttsQueue. When the next promise resolves, yield it.
      let drainIdx = 0;
      while (true) {
        if (drainIdx >= ttsQueue.length) {
          if (producerDone) break; // Producer is done and queue is drained
          // Briefly yield control so the producer can push more items
          await new Promise(resolve => setImmediate(resolve));
          continue;
        }

        const result = await ttsQueue[drainIdx++];

        // Handle special sentinel (transfer event)
        if (result.__special === 'transfer_agent') {
          await producerPromise;
          yield { type: 'transfer_agent', agentId: result.agentId, reason: result.reason };
          return;
        }

        yield { type: 'chunk', text: result.text, audio: result.audio };
        hasEmittedAnyChunk = true;
      }

      await producerPromise; // ensure producer has fully exited

      if (producerError && !hasEmittedAnyChunk) throw producerError;

      yield { type: 'final', fullText: fullResponseText };

    } catch (streamErr) {
      await producerPromise.catch(() => {});

      if (hasEmittedAnyChunk) throw streamErr;

      // ── Fallback: non-streaming response if stream never started ─────────
      console.warn('[Pipeline] Stream failed before first chunk — falling back to non-stream');
      const fallbackResponse = await this.generateGroqResponseWithFallback({
        messages,
        model:       llmModel,
        temperature: agent.temperature || 0.7,
        apiKey:      userSettings[`${llmProvider}Key`] || process.env.GROQ_API_KEY,
      });
      const fallbackText  = (fallbackResponse?.text || 'I am here to help.').trim();
      const fallbackAudio = await ttsService.textToSpeech({
        text: fallbackText, voiceId, speed, apiKey: ttsApiKey, provider: voiceProvider,
      });

      yield { type: 'chunk', text: fallbackText,  audio: fallbackAudio };
      yield { type: 'final', fullText: fallbackText };
    }
  }

  /**
   * Post-call analysis (Enhanced — Summary, Sentiment, Topics, Decisions, Intent, Urgency)
   */
  async analyzeCall(transcript) {
    if (!transcript || transcript.length === 0) return null;

    const formattedTranscript = transcript.map(m => `${m.role}: ${m.content}`).join('\n');
    
    const prompt = `
      Analyze the following phone call transcript thoroughly and provide a structured analysis.

      Transcript:
      ${formattedTranscript}

      Return ONLY a valid JSON object with these fields:
      {
        "summary": "A concise 1-2 sentence summary of the call",
        "sentiment": "positive" | "neutral" | "negative",
        "topics": ["list", "of", "main", "topics", "discussed"],
        "decisions": ["any decisions made during the call"],
        "customerIntent": "what the customer wanted (e.g. purchase, support, inquiry, complaint)",
        "urgencyLevel": "low" | "medium" | "high" | "critical",
        "followUpRequired": true | false,
        "actionItems": ["specific next steps or tasks"],
        "extractedData": { "name": "", "email": "", "phone": "", "company": "", "date": "" },
        "emotion": "happy" | "angry" | "sad" | "frustrated" | "neutral",
        "metrics": { "nps": 0, "csat": 0 },
        "qaScore": 95,
        "qaGrade": "A",
        "tags": ["auto-generated", "tag", "labels"]
      }

      Rules:
      - Only include extractedData fields that were actually mentioned
      - Be accurate with sentiment — frustrated or angry customers = negative
      - followUpRequired = true if there are pending action items or unresolved questions
      - urgencyLevel = critical only for emergencies or angry escalations
      - qaScore = Evaluate the AI agent's performance from 0 to 100 based on: greeting quality, listening, accuracy, empathy, resolution, and professionalism
      - qaGrade = A (90-100), B (80-89), C (70-79), D (60-69), F (<60)
      - tags = Auto-generate 2-5 tags describing this call (e.g. "refund", "billing", "vip", "escalated", "resolved", "complaint", "inquiry", "demo-request", "follow-up-needed")
    `;

    try {
      const response = await groqService.generateResponse({
        messages: [
          { role: 'system', content: 'You are a professional call analyst. Always respond with ONLY valid JSON, no markdown, no explanation.' },
          { role: 'user', content: prompt },
        ],
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
        jsonMode: true,
      });

      const cleanJson = response.text.replace(/```json|```/g, '').trim();
      return JSON.parse(cleanJson);
    } catch (e) {
      console.error('Post-call analysis failed:', e.message);
      return null;
    }
  }

  /**
   * Real-time sentiment classification for live calls
   * SMART MODE: Keyword-first (0ms), LLM only for ambiguous text (saves ~300ms & tokens)
   * Returns: { sentiment: 'positive'|'neutral'|'negative', score: -1 to 1 }
   */
  async classifySentiment(text) {
    if (!text || text.trim().length < 3) {
      return { sentiment: 'neutral', score: 0 };
    }

    // Phase 1: Fast keyword-based classification (instant, zero cost)
    const keywordResult = this.keywordSentiment(text);
    
    // If keyword analysis is confident (strong signal), skip LLM entirely
    const absScore = Math.abs(keywordResult.score);
    if (absScore >= 0.5) {
      return keywordResult; // High confidence — no LLM call needed
    }

    // Phase 2: Short text with no keywords → default neutral (don't waste tokens)
    if (text.trim().split(/\s+/).length < 5) {
      return keywordResult;
    }

    // Phase 3: Ambiguous text → use LLM for accurate classification
    try {
      const response = await groqService.generateResponse({
        messages: [
          {
            role: 'system',
            content: 'Classify the sentiment of the user\'s message. Respond with ONLY a JSON object: {"s":"p"|"n"|"neg","v":number} where s=sentiment (p=positive,n=neutral,neg=negative) and v=score from -1.0 to 1.0. Nothing else.',
          },
          { role: 'user', content: text },
        ],
        model: 'llama-3.1-8b-instant',
        temperature: 0,
      });

      const cleanJson = response.text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleanJson);

      const sentimentMap = { p: 'positive', n: 'neutral', neg: 'negative' };
      return {
        sentiment: sentimentMap[parsed.s] || 'neutral',
        score: typeof parsed.v === 'number' ? Math.max(-1, Math.min(1, parsed.v)) : 0,
      };
    } catch (e) {
      return keywordResult; // Fallback to keyword result
    }
  }

  /**
   * Fast keyword-based sentiment fallback (no LLM call)
   */
  keywordSentiment(text) {
    const lower = text.toLowerCase();
    const positiveWords = ['thank', 'great', 'good', 'awesome', 'perfect', 'love', 'happy', 'excellent', 'wonderful', 'amazing', 'shukriya', 'dhanyavaad', 'bahut accha', 'best'];
    const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'angry', 'frustrated', 'worst', 'horrible', 'complaint', 'problem', 'issue', 'wrong', 'bura', 'galat', 'pareshan', 'gussa'];

    const posCount = positiveWords.filter(w => lower.includes(w)).length;
    const negCount = negativeWords.filter(w => lower.includes(w)).length;

    if (posCount > negCount) return { sentiment: 'positive', score: Math.min(1, posCount * 0.3) };
    if (negCount > posCount) return { sentiment: 'negative', score: -Math.min(1, negCount * 0.3) };
    return { sentiment: 'neutral', score: 0 };
  }

  /**
   * Check if call should be transferred to a human agent
   * Evaluates 3 conditions based on agent transfer settings
   * Returns: { shouldTransfer: boolean, reason: string }
   */
  shouldTransfer({ transcript, sentimentHistory, agent }) {
    if (!agent.transferNumber || agent.transferNumber === '') {
      return { shouldTransfer: false, reason: '' };
    }

    const conditions = agent.transferConditions || {};

    // 1. Sustained negative sentiment (last 3+ messages negative)
    if (conditions.onNegativeSentiment && sentimentHistory && sentimentHistory.length >= 3) {
      const lastThree = sentimentHistory.slice(-3);
      const allNegative = lastThree.every(s => s.sentiment === 'negative');
      if (allNegative) {
        return {
          shouldTransfer: true,
          reason: 'sustained_negative_sentiment',
        };
      }
    }

    // 2. Key phrases detection
    const defaultTransferPhrases = [
      'talk to human', 'talk to a human', 'real person', 'real agent',
      'human agent', 'speak to someone', 'transfer me', 'connect me',
      'manager', 'supervisor', 'operator',
      // Hindi phrases
      'insaan se baat', 'agent se baat', 'kisi aur se baat', 'manager se milao',
      'real insaan', 'transfer karo', 'connect karo', 'kisi ko bulao',
    ];
    const agentPhrases = conditions.onKeyPhrases || [];
    const allPhrases = [...defaultTransferPhrases, ...agentPhrases];

    if (transcript && transcript.length > 0) {
      const lastUserMsg = transcript.filter(m => m.role === 'user').slice(-1)[0];
      if (lastUserMsg) {
        const lowerText = (lastUserMsg.content || '').toLowerCase();
        const matched = allPhrases.find(p => lowerText.includes(p));
        if (matched) {
          return {
            shouldTransfer: true,
            reason: `key_phrase: "${matched}"`,
          };
        }
      }
    }

    // 3. Max failed attempts (agent repeated "I don't know" type responses)
    const maxFailed = conditions.maxFailedAttempts || 3;
    if (transcript && transcript.length >= maxFailed * 2) {
      const assistantMsgs = transcript.filter(m => m.role === 'assistant').slice(-maxFailed);
      const failPhrases = [
        "i don't know", "i'm not sure", "i cannot help", "i can't help",
        "let me check", "i don't have that information", "not available",
        "mujhe nahi pata", "mujhe malum nahi", "main nahi bata sakta",
      ];
      const failedCount = assistantMsgs.filter(m => {
        const lower = (m.content || '').toLowerCase();
        return failPhrases.some(f => lower.includes(f));
      }).length;

      if (failedCount >= maxFailed) {
        return {
          shouldTransfer: true,
          reason: `max_failed_attempts (${failedCount}/${maxFailed})`,
        };
      }
    }

    return { shouldTransfer: false, reason: '' };
  }

  /**
   * Get a backchannel response if appropriate
   */
  getBackchannel(text) {
    const lowConfidenceAcks = ['okay', 'i see', 'hmm', 'got it', 'interesting'];
    if (text.length < 10 && Math.random() > 0.7) {
      return lowConfidenceAcks[Math.floor(Math.random() * lowConfidenceAcks.length)];
    }
    return null;
  }

  /**
   * Rolling conversation summarizer for long calls.
   * When history exceeds threshold, summarizes older messages into a compact string
   * and keeps only the most recent messages verbatim.
   * This prevents LLM context window overflow and maintains coherence.
   *
   * Returns: { summary: string|null, recentHistory: Array }
   */
  async compressHistory(history) {
    if (!history || history.length <= this._summaryThreshold) {
      return { summary: null, recentHistory: history };
    }

    const olderMessages = history.slice(0, history.length - this._summaryKeepRecent);
    const recentHistory = history.slice(-this._summaryKeepRecent);

    const olderFormatted = olderMessages.map(m => `${m.role}: ${m.content}`).join('\n');

    try {
      const response = await groqService.generateResponse({
        messages: [
          {
            role: 'system',
            content: 'Summarize this call conversation in 3-5 bullet points. Include key facts, decisions, and any data mentioned (names, numbers, dates). Be concise. Respond with ONLY the summary, no preamble.',
          },
          { role: 'user', content: olderFormatted },
        ],
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
      });

      const summary = response.text.trim();
      console.log(`[Rolling Summary] Compressed ${olderMessages.length} older messages into summary`);
      return { summary, recentHistory };
    } catch (e) {
      console.error('[Rolling Summary] Failed:', e.message);
      // Fallback: just truncate
      return { summary: null, recentHistory: history.slice(-10) };
    }
  }

  /**
   * Build system prompt for the agent
   */
  buildSystemPrompt(agent, memory = null, ragContext = '') {
    const lang = agent.language || 'en';
    const langInstruction = lang === 'en' ? 'English' : lang === 'hi' ? 'Hindi' : lang === 'hi-Latn' ? 'Hinglish (Hindi in Roman script)' : lang === 'multi' ? 'the same language the user speaks in' : lang;

    let prompt = `You are "${agent.name}", a live AI voice agent on a phone call. Your personality, role, and behavior are defined ENTIRELY by the instructions below. You must follow them as your highest priority.

## YOUR INSTRUCTIONS (FOLLOW EXACTLY):
${agent.systemPrompt}

## VOICE CALL RULES (always apply):
- You are on a LIVE VOICE CALL. Your text is spoken aloud via TTS.
- Keep responses SHORT and conversational (1-3 sentences per turn). Do NOT give long monologues.
- NEVER use markdown: no **, no *, no #, no -, no bullet points, no numbered lists.
- Use plain spoken language only. Write as you would speak naturally.
- Respond in ${langInstruction}.
- Ask one question at a time. Wait for the user to answer before moving on.
- If you don't know something, say so honestly. Don't make up information.
- Current date: ${new Date().toDateString()}.
`;

    if (agent.transferToAgentId) {
      prompt += `\n- If the user needs help you cannot provide, use the "transfer_to_agent" tool with agentId "${agent.transferToAgentId}".`;
    }

    if (memory && memory.facts?.length > 0) {
      const factsStr = memory.facts.map(f => `- ${f.content}`).join('\n');
      prompt += `\n\n## CALLER MEMORY (previous interactions):\n${factsStr}`;
    }

    if (ragContext) {
      prompt += `\n\n## KNOWLEDGE BASE CONTEXT (use this to answer questions):\n${ragContext}`;
    }

    return prompt;
  }

  /**
   * Check if user wants to end the call
   */
  shouldEndCall(text, agent) {
    const defaultEndPhrases = ['goodbye', 'bye', 'hang up', 'end call', 'stop', 'quit', 'exit'];
    // Hindi end phrases — common ways to say bye/end in Hindi/Hinglish
    const hindiEndPhrases = [
      'alvida', 'namaste', 'dhanyavaad', 'shukriya', 'theek hai', 'bas', 
      'band karo', 'ruk jao', 'rukiye', 'bye bye', 'chhodo', 'jane do',
    ];
    const agentEndPhrases = agent.endCallPhrases || [];
    const allPhrases = [...defaultEndPhrases, ...hindiEndPhrases, ...agentEndPhrases];

    const lowerText = text.toLowerCase().trim();
    return allPhrases.some(phrase => lowerText.includes(phrase));
  }

  /**
   * Get the agent's first message as audio
   */
  async getFirstMessageAudio(agent) {
    const text = agent.firstMessage || 'Hello! How can I help you today?';
    
    const lang = agent.language || 'en';
    let defaultVoiceId = 'en-US-JennyNeural';
    if (lang === 'hi' || lang === 'hi-Latn' || lang === 'multi') defaultVoiceId = 'hi-IN-SwaraNeural';
    else if (lang === 'ta') defaultVoiceId = 'ta-IN-PallaviNeural';
    else if (lang === 'te') defaultVoiceId = 'te-IN-ShrutiNeural';
    else if (lang === 'kn') defaultVoiceId = 'kn-IN-SapnaNeural';
    else if (lang === 'ml') defaultVoiceId = 'ml-IN-SobhanaNeural';
    else if (lang === 'mr') defaultVoiceId = 'mr-IN-AarohiNeural';
    else if (lang === 'gu') defaultVoiceId = 'gu-IN-DhwaniNeural';
    else if (lang === 'bn') defaultVoiceId = 'bn-IN-TanishaaNeural';
    else if (lang === 'ur') defaultVoiceId = 'ur-IN-GulNeural';
    else if (lang === 'pa') defaultVoiceId = 'pa-IN-OjasNeural';
    else if (lang === 'en-IN') defaultVoiceId = 'en-IN-NeerjaNeural';

    const voiceId = agent.voice?.voiceId || defaultVoiceId;
    const provider = agent.voice?.provider || 'edge-tts';

    try {
      const audioBuffer = await ttsService.textToSpeech({ text, voiceId, provider });
      return { text, audioBuffer };
    } catch (error) {
      return { text, audioBuffer: Buffer.alloc(0) };
    }
  }
}

module.exports = new VoicePipeline();
