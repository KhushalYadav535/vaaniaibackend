/**
 * Main Voice Pipeline Orchestrator
 * Flow: Audio Input → STT (Deepgram) → LLM (Groq) → TTS (Edge TTS) → Audio Output
 */
const groqService = require('./groqService');
const ttsService = require('./ttsService');
const deepgramService = require('./deepgramService');
const toolExecutor = require('./toolExecutor');
const KnowledgeBase = require('../models/KnowledgeBase');

class VoicePipeline {
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
      } else if (llmProvider === 'groq' || !userSettings.openaiKey) {
        llmResponse = await groqService.generateResponse({
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
   * This is much faster for real-time voice
   */
  async *processTextStream({ text, agent, history = [], userSettings = {}, memory = null, ragContext = '' }) {
    const currentEmotion = this.detectEmotion(text);
    let emotionPrompt = '';
    if (currentEmotion === 'angry') emotionPrompt = '\n[SYSTEM DIRECTIVE]: The user seems frustrated or angry. Adopt a highly empathetic, calming, and apologetic tone immediately.';
    if (currentEmotion === 'urgent') emotionPrompt = '\n[SYSTEM DIRECTIVE]: The user has an urgent issue. Be extremely concise, fast, and helpful. Get straight to the point.';

    const messages = [
      { role: 'system', content: this.buildSystemPrompt(agent, memory, ragContext) + emotionPrompt },
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: text },
    ];

    const llmProvider = agent.llm?.provider || 'groq';
    const llmModel = agent.llm?.model || 'llama-3.1-8b-instant';
    const voiceId = agent.voice?.voiceId || 'en-US-JennyNeural';
    const speed = agent.voice?.speed || 1.0;

    let fullResponseText = '';
    let currentSentence = '';
    
    // Check for Dynamic Knowledge (RAG 2.0)
    let dynamicKnowledge = '';
    if (agent.knowledgeBaseId) {
      // Find relevant chunks (Simplified for now)
      const kb = await KnowledgeBase.findById(agent.knowledgeBaseId);
      if (kb) {
        // Logic for finding relevant content in KnowledgeBase (Retell/Vapi style)
        dynamicKnowledge = `\n[Dynamic Knowledge Context]:\n${kb.content.substring(0, 1000)}`;
      }
    }

    // Build tool context for Tool Calling (Vapi/Retell style)
    const toolInstructions = agent.webhooks?.length > 0 ? 
      `\n[Tool Instructions]: You can call these tools if needed: ${agent.webhooks.map(w => w.name).join(', ')}. Format: <TOOL>function_name(args)</TOOL>` : '';

    const systemPrompt = this.buildSystemPrompt(agent, memory) + dynamicKnowledge + toolInstructions + emotionPrompt;
    messages[0].content = systemPrompt;

    // Inject Filler Word to reduce perceived latency
    if (agent.advanced?.fillerWords && Math.random() < 0.35) {
      const fillers = ["Hmm...", "Let me see...", "Umm...", "Okay...", "Well..."];
      const filler = fillers[Math.floor(Math.random() * fillers.length)];
      
      const audioBuffer = await ttsService.textToSpeech({
        text: filler,
        voiceId,
        speed,
        apiKey: userSettings.ttsKey || process.env.ELEVENLABS_API_KEY,
      });

      yield {
        type: 'chunk',
        text: filler + ' ',
        audio: audioBuffer,
      };
    }

    // Use streaming LLM or Custom Webhook
    let tokenStream;
    if (agent.advanced?.customLlmUrl) {
      tokenStream = (async function* () {
        const axios = require('axios');
        try {
          const res = await axios.post(agent.advanced.customLlmUrl, { messages, agentId: agent._id });
          const text = typeof res.data === 'string' ? res.data : (res.data?.text || res.data?.response || JSON.stringify(res.data));
          // Split into words or sentences to simulate stream
          const words = text.split(' ');
          for (const w of words) yield w + ' ';
        } catch (e) {
          console.error("Custom LLM Webhook failed:", e.message);
          yield "Sorry, my external intelligence server is offline.";
        }
      })();
    } else {
      tokenStream = groqService.generateStreamResponse({
        messages,
        model: llmModel,
        temperature: agent.temperature || 0.7,
        apiKey: userSettings[`${llmProvider}Key`] || process.env.GROQ_API_KEY,
      });
    }

    for await (const token of tokenStream) {
      fullResponseText += token;
      currentSentence += token;

      // Tool Execution Logic (Vapi/Retell style)
      if (fullResponseText.includes('<TOOL>') && fullResponseText.includes('</TOOL>')) {
        const toolMatch = fullResponseText.match(/<TOOL>(.*?)<\/TOOL>/);
        if (toolMatch) {
          const toolCallStr = toolMatch[1]; // e.g. "get_stock_price({symbol: 'AAPL'})"
          const name = toolCallStr.split('(')[0];
          const argsStr = toolCallStr.match(/\((.*?)\)/)?.[1] || '{}';
          
          try {
            const args = JSON.parse(argsStr.replace(/'/g, '"'));
            const toolResult = await toolExecutor.executeTool({ toolName: name, toolInput: args, agentContext: agent });
            
            if (toolResult.result && toolResult.result.__transferToAgentId) {
              yield {
                type: 'transfer_agent',
                agentId: toolResult.result.__transferToAgentId,
                reason: toolResult.result.reason
              };
              return; // Stop current stream
            }

            // Add tool result back to conversation context and restart generation
            // (Simplified: for now we just append result to prompt and continue)
            console.log(`[Tool Executed] Result:`, toolResult);
            fullResponseText = fullResponseText.replace(toolMatch[0], ` [Result: ${JSON.stringify(toolResult)}] `);
          } catch (e) {
            console.error('Tool parsing failed:', e.message);
          }
        }
      }

      // Check if we have a complete sentence (., !, ?, or \n)
      if (/[.!?\n]/.test(token) && currentSentence.trim().length > 5) {
        const sentenceToSpeak = currentSentence.trim();
        currentSentence = '';

        // Generate TTS for this sentence
        const audioBuffer = await ttsService.textToSpeech({
          text: sentenceToSpeak,
          voiceId,
          speed,
          apiKey: userSettings.ttsKey || process.env.ELEVENLABS_API_KEY,
        });

        yield {
          type: 'chunk',
          text: sentenceToSpeak,
          audio: audioBuffer,
        };
      }
    }

    // Process any remaining text
    if (currentSentence.trim().length > 0) {
      const audioBuffer = await ttsService.textToSpeech({
        text: currentSentence.trim(),
        voiceId,
        speed,
        apiKey: userSettings.ttsKey || process.env.ELEVENLABS_API_KEY,
      });

      yield {
        type: 'chunk',
        text: currentSentence.trim(),
        audio: audioBuffer,
      };
    }

    yield {
      type: 'final',
      fullText: fullResponseText,
    };
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
        "qaScore": 95
      }

      Rules:
      - Only include extractedData fields that were actually mentioned
      - Be accurate with sentiment — frustrated or angry customers = negative
      - followUpRequired = true if there are pending action items or unresolved questions
      - urgencyLevel = critical only for emergencies or angry escalations
      - qaScore = Evaluate the AI agent's performance from 0 to 100 based on politeness, accuracy, and helpfulness.
    `;

    try {
      const response = await groqService.generateResponse({
        messages: [
          { role: 'system', content: 'You are a professional call analyst. Always respond with ONLY valid JSON, no markdown, no explanation.' },
          { role: 'user', content: prompt },
        ],
        model: 'llama-3.1-8b-instant',
        temperature: 0.1,
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
   * Ultra-fast — uses minimal tokens for instant response
   * Returns: { sentiment: 'positive'|'neutral'|'negative', score: -1 to 1 }
   */
  async classifySentiment(text) {
    if (!text || text.trim().length < 3) {
      return { sentiment: 'neutral', score: 0 };
    }

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
      // Fallback: simple keyword-based sentiment
      return this.keywordSentiment(text);
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
   * Build system prompt for the agent
   */
  buildSystemPrompt(agent, memory = null, ragContext = '') {
    let prompt = `
      You are a helpful AI voice agent named ${agent.name}.
      Description: ${agent.description || 'A professional voice assistant.'}

      ${agent.systemPrompt}

      CRITICAL RULES FOR VOICE:
      1. Your responses will be spoken aloud via Text-to-Speech. Keep them concise and conversational.
      2. NEVER use markdown like asterisks (**), dashes (-), or hashes (#). Use plain text only.
      3. Use natural pauses and phrasing.
      4. Always respond in the language: ${agent.language || 'en'}.
    `;

    if (agent.transferToAgentId) {
      prompt += `\n      5. If the user asks to be transferred to a different department, or needs specialized help you cannot provide, use the "transfer_to_agent" tool with agentId "${agent.transferToAgentId}".`;
    }

    prompt += `\n
      Current Date: ${new Date().toDateString()}

      [Strict Rules]:
      1. Be concise. Use short sentences (Vapi/Retell style).
      2. If you don't know something, say you'll check.
      3. Never use markdown formatting (bold, italics, lists) in speech.
    `;

    // Add User Memory (Pichli baatein)
    if (memory && memory.facts?.length > 0) {
      const factsStr = memory.facts.map(f => `- ${f.content}`).join('\n');
      prompt += `\n[User Memory (Pichli baatein)]:\n${factsStr}`;
    }

    // Add RAG Context
    if (ragContext) {
      prompt += ragContext;
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

    try {
      const audioBuffer = await ttsService.textToSpeech({ text, voiceId });
      return { text, audioBuffer };
    } catch (error) {
      return { text, audioBuffer: Buffer.alloc(0) };
    }
  }
}

module.exports = new VoicePipeline();
