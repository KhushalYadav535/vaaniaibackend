/**
 * Prompt Optimizer Route
 *
 * Takes the current agent prompt + metadata and returns a fully
 * optimized VaaniAI voice-agent system prompt via LLM.
 *
 * POST /api/optimize-prompt
 * Body: { currentPrompt, agentName, language, role }
 * Returns: { optimizedPrompt }
 */

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth');
const axios = require('axios');

router.post('/', protect, async (req, res) => {
  const { currentPrompt = '', agentName = 'Assistant', language = 'hi', role = '' } = req.body;

  const langLabel = language === 'hi' ? 'Hindi (Devnagari)'
    : language === 'hi-Latn' ? 'Hinglish (Roman script)'
    : language === 'multi'   ? 'Hindi/English mixed (Hinglish)'
    : language === 'en'      ? 'English'
    : language;

  const metaPrompt = `You are a VaaniAI voice agent prompt expert. VaaniAI is a real-time Hindi/Hinglish voice AI platform used by Indian businesses for sales, support, and lead qualification.

Your job: Take the existing agent prompt below and rewrite it as a PERFECT VaaniAI system prompt.

AGENT DETAILS:
- Name: ${agentName}
- Language: ${langLabel}
- Role/Purpose: ${role || 'Not specified — infer from current prompt'}

CURRENT PROMPT:
${currentPrompt || '(empty — create a new one from scratch based on name and role)'}

RULES FOR THE OPTIMIZED PROMPT:
1. Structure it with clear sections: # Role, # Task, # Instructions, # About Company (if applicable), # Conversation Flow
2. Write in ${langLabel} style — if Hindi/Hinglish, use natural conversational tone
3. Persona: The agent is a REAL person, NOT an AI. Never break character.
4. Voice-first: No bullet points in responses, no markdown in spoken text. Short natural sentences only.
5. Conversation flow: Greet warmly → ask one question at a time → gather info gradually → never overwhelm
6. If user asks "are you an AI?", the agent deflects naturally: "Main ${agentName} hoon, batao main aapki kaise madad kar sakti hoon?"
7. Include a clear objective (what the agent should accomplish in each call)
8. Include handling for: unclear audio, user going off-topic, call ending gracefully
9. Language instruction: Respond in ${langLabel}. Match user's code-switching.
10. Be COMPLETE — do not cut off mid-sentence. Write the FULL prompt even if it is long.

OUTPUT: Return ONLY the optimized system prompt text. No explanations, no preamble, no markdown code blocks.`;

  try {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.1-8b-instruct';

    if (!openrouterKey) {
      return res.status(500).json({ success: false, message: 'OpenRouter API key not configured' });
    }

    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: metaPrompt }],
        max_tokens: 2000,
        temperature: 0.7,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${openrouterKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_SITE_NAME || 'VaaniAI',
          'X-Title': 'VaaniAI Prompt Optimizer',
        },
        timeout: 40000, // 40s — prompt generation is one-time, not real-time voice
      }
    );

    const optimized = response.data?.choices?.[0]?.message?.content?.trim();
    if (!optimized) {
      return res.status(500).json({ success: false, message: 'LLM returned empty response' });
    }

    console.log(`[PromptOptimizer] ✅ Generated optimized prompt for agent "${agentName}" (${optimized.length} chars)`);
    res.json({ success: true, optimizedPrompt: optimized });

  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    console.error('[PromptOptimizer] ❌ Error:', msg);
    res.status(500).json({ success: false, message: `Optimization failed: ${msg}` });
  }
});

module.exports = router;
