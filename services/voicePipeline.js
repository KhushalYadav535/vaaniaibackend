/**
 * Main Voice Pipeline Orchestrator
 * Flow: Audio Input → STT (Deepgram) → LLM (Groq) → TTS (Edge TTS) → Audio Output
 */
const groqService = require('./groqService');
const geminiService = require('./geminiService');
const ttsService = require('./ttsService');
const deepgramService = require('./deepgramService');
const toolExecutor = require('./toolExecutor');
const llmFallback = require('./llmFallback');
const KnowledgeBase = require('../models/KnowledgeBase');

class VoicePipeline {
  constructor() {
    // LRU response cache for FAQ-type repeated queries
    this._responseCache = new Map();
    this._responseCacheMaxEntries = Number(process.env.LLM_RESPONSE_CACHE_MAX || 50);
    this._responseCacheEnabled = String(process.env.LLM_RESPONSE_CACHE_ENABLED || 'true').toLowerCase() === 'true';
    this._responseCacheTtlMs = Number(process.env.LLM_RESPONSE_CACHE_TTL_MS || 300000); // 5 min

    // Per-session rolling-summary cache: sessionId → { summary, coveredCount, inFlight }.
    // Keeps the expensive summary Groq call OFF the per-turn critical path.
    this._summaryCache = new Map();

    // Rolling summary settings
    // Llama 3.1 8B has an 8k context window. We can safely keep 15-20 short
    // conversational messages verbatim without blowing the TPM budget.
    this._summaryThreshold = Number(process.env.ROLLING_SUMMARY_THRESHOLD || 25); // summarize after N messages
    this._summaryKeepRecent = Number(process.env.ROLLING_SUMMARY_KEEP_RECENT || 15); // keep last N messages verbatim
    // Recompute the cached summary only after this many NEW older messages
    // accumulate. Between recomputes we reuse the cached summary, so the
    // expensive summary Groq call no longer fires on every single turn
    // (that was flooding the free-tier TPM limit and starving the reply).
    this._summaryRecomputeEvery = Number(process.env.ROLLING_SUMMARY_RECOMPUTE_EVERY || 10);

    // Language-specific filler words for natural turn-taking
    this._fillersByLang = {
      'en':      ['Hmm...', 'Let me see...', 'Umm...', 'So...', 'Well...', 'Right...', 'Okay so...'],
      // hi = pure Devnagari Hindi → fillers must be Devnagari so they cache-hit
      // with the same voice+script used for main responses
      'hi':      ['हम्म...', 'एक सेकंड...', 'अच्छा...', 'देखते हैं...', 'हाँ...', 'जी...', 'ठीक है...'],
      'hi-Latn': ['Hmm...', 'Ek sec...', 'Acchaa...', 'Toh basically...', 'Haan...', 'Dekho...'],
      'multi':   ['Hmm...', 'Accha...', 'Let me check...', 'Toh...', 'Okay...', 'Haan...'],
      'en-IN':   ['Hmm...', 'One second...', 'Okay so...', 'Let me check...', 'Right...'],
    };
  }

  /**
   * Devnagari → Roman transliterator (last line of defense).
   *
   * Llama 3.1 8B mirrors the user's script even when system prompt says
   * "Roman only". When STT gives us "विद्यापीठ" the model echoes it.
   * Edge TTS then mispronounces or skips Devnagari glyphs entirely.
   *
   * This is a simple character-by-character map — not full ITRANS
   * accuracy, but good enough that the TTS engine will speak something
   * recognizable instead of going silent on a Devnagari word. Diacritics
   * approximate (ज़ → z, फ़ → f).
   */
  _transliterateDevnagari(text) {
    if (!text || !/[ऀ-ॿ]/.test(text)) return text; // Fast path: no Devnagari

    // ── Common word dictionary ──────────────────────────────────────
    // Character-by-character transliteration can't handle schwa deletion
    // and vowel quality perfectly for every word. This dictionary maps
    // frequently-used Devnagari words/phrases to their natural Hinglish
    // spelling — the way a real person would type them on WhatsApp.
    const wordMap = {
      // Greetings
      'नमस्ते':'namaste', 'नमस्कार':'namaskar', 'धन्यवाद':'dhanyavaad',
      'शुक्रिया':'shukriya', 'माफ़':'maaf', 'माफ':'maaf', 'कृपया':'kripya',
      'स्वागत':'swaagat', 'अलविदा':'alvida',
      // Pronouns
      'मैं':'main', 'हम':'hum', 'आप':'aap', 'तुम':'tum', 'तू':'tu',
      'वो':'wo', 'वह':'woh', 'यह':'yeh', 'ये':'ye', 'वे':'ve',
      // Possessives
      'मेरा':'mera', 'मेरी':'meri', 'मेरे':'mere',
      'आपका':'aapka', 'आपकी':'aapki', 'आपके':'aapke',
      'आपको':'aapko', 'आपने':'aapne', 'आपसे':'aapse',
      'हमारा':'hamara', 'हमारी':'hamari', 'हमारे':'hamare',
      'उसका':'uska', 'उसकी':'uski', 'उसके':'uske',
      'इसका':'iska', 'इसकी':'iski', 'इसके':'iske',
      'उनका':'unka', 'उनकी':'unki', 'उनके':'unke',
      'किसी':'kisi', 'किसका':'kiska', 'किसको':'kisko', 'किसने':'kisne',
      // Postpositions / particles
      'में':'mein', 'से':'se', 'को':'ko', 'का':'ka', 'की':'ki', 'के':'ke',
      'पर':'par', 'और':'aur', 'या':'ya', 'तो':'to', 'भी':'bhi', 'ही':'hi',
      'तक':'tak', 'साथ':'saath', 'बाद':'baad', 'पहले':'pehle',
      'लिए':'liye', 'बारे':'baare', 'बीच':'beech', 'ऊपर':'upar', 'नीचे':'neeche',
      // Verbs
      'है':'hai', 'हैं':'hain', 'हो':'ho', 'हूँ':'hoon', 'था':'tha', 'थी':'thi', 'थे':'the',
      'कर':'kar', 'करें':'karein', 'करो':'karo', 'करूँ':'karoon',
      'करती':'karti', 'करता':'karta', 'करते':'karte', 'करना':'karna', 'करके':'karke',
      'सकती':'sakti', 'सकता':'sakta', 'सकते':'sakte', 'सकूँ':'sakoon',
      'रही':'rahi', 'रहा':'raha', 'रहे':'rahe', 'रहेंगे':'rahenge', 'रहेगा':'rahega', 'रहेगी':'rahegi',
      'बताइए':'bataiye', 'बताइये':'bataiye', 'बताएं':'batayein', 'बताओ':'batao', 'बता':'bata',
      'बोल':'bol', 'बोलिए':'boliye', 'बोलिये':'boliye', 'बोलो':'bolo',
      'दीजिए':'dijiye', 'दीजिये':'dijiye', 'दें':'dein', 'दो':'do', 'दूँ':'doon',
      'कीजिए':'kijiye', 'कीजिये':'kijiye',
      'लेती':'leti', 'लेता':'leta', 'लेते':'lete',
      'देती':'deti', 'देता':'deta', 'देते':'dete',
      'चाहिए':'chahiye', 'चाहिये':'chahiye', 'चाहते':'chahte', 'चाहती':'chahti',
      'चाहेंगे':'chahenge', 'चाहेंगी':'chahengi',
      'किया':'kiya', 'दिया':'diya', 'लिया':'liya', 'गया':'gaya', 'गई':'gayi', 'गए':'gaye',
      'आई':'aayi', 'आया':'aaya', 'आए':'aaye', 'आता':'aata', 'आती':'aati',
      'मिला':'mila', 'मिली':'mili', 'मिलेगा':'milega', 'मिलेगी':'milegi',
      'लगता':'lagta', 'लगती':'lagti',
      'समझ':'samajh', 'समझा':'samjha', 'समझे':'samjhe', 'समझें':'samjhein',
      'चुनी':'chuni', 'चुना':'chuna', 'चुने':'chune',
      // Negation / fillers
      'नहीं':'nahi', 'नही':'nahi', 'मत':'mat', 'ना':'na', 'जी':'ji', 'हाँ':'haan', 'हां':'haan',
      // Adjectives
      'अच्छा':'achha', 'अच्छी':'achhi', 'अच्छे':'achhe',
      'ठीक':'theek', 'सही':'sahi', 'गलत':'galat',
      'बहुत':'bahut', 'ज़्यादा':'zyada', 'ज्यादा':'zyada', 'कम':'kam',
      'बड़ा':'bada', 'बड़ी':'badi', 'बड़े':'bade',
      'छोटा':'chhota', 'छोटी':'chhoti', 'छोटे':'chhote',
      'पूरा':'poora', 'पूरी':'poori', 'पूरे':'poore',
      'कुछ':'kuchh', 'कोई':'koi', 'दूसरा':'doosra', 'दूसरी':'doosri', 'दूसरे':'doosre',
      'जल्द':'jald', 'जल्दी':'jaldi', 'अभी':'abhi', 'तुरंत':'turant',
      'शुभ':'shubh', 'आगे':'aage',
      // Question words
      'क्या':'kya', 'कौन':'kaun', 'कहाँ':'kahan', 'कब':'kab',
      'कितना':'kitna', 'कितनी':'kitni', 'कैसे':'kaise', 'कैसा':'kaisa', 'कैसी':'kaisi', 'क्यों':'kyon',
      // Connectors
      'लेकिन':'lekin', 'इसलिए':'isliye', 'क्योंकि':'kyonki', 'अगर':'agar',
      'फिर':'phir', 'जिसके':'jiske', 'अपना':'apna', 'अपनी':'apni', 'अपने':'apne',
      // Banking / support
      'नंबर':'number', 'नम्बर':'number', 'फोन':'phone', 'मोबाइल':'mobile',
      'खाता':'khaata', 'बैंक':'bank', 'लोन':'loan', 'अकाउंट':'account',
      'पैसे':'paise', 'पैसा':'paisa', 'रुपये':'rupaye', 'लाख':'laakh', 'हज़ार':'hazaar', 'हजार':'hazaar',
      'निकालने':'nikalne', 'दर्ज':'darj', 'जमा':'jama',
      'ब्याज':'byaaj', 'किस्त':'kist', 'अवधि':'avadhi',
      'अधिकारी':'adhikari', 'सहायता':'sahayata', 'मदद':'madad',
      'समस्या':'samasya', 'शिकायत':'shikayat', 'सवाल':'sawaal',
      'जानकारी':'jaankari', 'विवरण':'vivran', 'प्रकार':'prakaar',
      'प्रक्रिया':'prakriya', 'संपर्क':'sampark',
      'काट':'kaat', 'बंद':'band', 'चालू':'chaalu', 'शुरू':'shuru',
      'जुड़ने':'judne', 'जुड़े':'jude', 'पर्सनल':'personal', 'ईमेल':'email',
      // Time
      'आज':'aaj', 'कल':'kal', 'साल':'saal', 'महीना':'mahina', 'दिन':'din',
      // Misc common
      'यहाँ':'yahan', 'वहाँ':'wahan', 'ज़रूर':'zaroor', 'जरूर':'zaroor',
      'बात':'baat', 'काम':'kaam', 'नाम':'naam', 'घर':'ghar',
      'चरणों':'charnon', 'बोल':'bol',
    };

    // First pass: replace whole Devnagari words using the dictionary.
    // Split on word boundaries, replace known words, transliterate the rest.
    const tokens = text.split(/(\s+|[.,!?;:।]+)/);
    const result = tokens.map(token => {
      // Whitespace / punctuation — pass through
      if (!token || !/[ऀ-ॿ]/.test(token)) return token;

      // Exact dictionary match (whole token is a known word)
      if (wordMap[token]) return wordMap[token];

      // Token might have punctuation attached: strip trailing punct, lookup, re-attach
      const trailingPunct = token.match(/([.,!?;:।]+)$/);
      const bare = trailingPunct ? token.slice(0, -trailingPunct[0].length) : token;
      if (wordMap[bare]) return wordMap[bare] + (trailingPunct ? trailingPunct[0] : '');

      // ── Character-by-character fallback ─────────────────────────
      return this._transliterateWord(bare) + (trailingPunct ? trailingPunct[0] : '');
    });

    return result.join('');
  }

  /** Transliterate a single Devnagari word (no dictionary match). */
  _transliterateWord(word) {
    const consonants = {
      'क':'k','ख':'kh','ग':'g','घ':'gh','ङ':'ng',
      'च':'ch','छ':'chh','ज':'j','झ':'jh','ञ':'ny',
      'ट':'t','ठ':'th','ड':'d','ढ':'dh','ण':'n',
      'त':'t','थ':'th','द':'d','ध':'dh','न':'n',
      'प':'p','फ':'ph','ब':'b','भ':'bh','म':'m',
      'य':'y','र':'r','ल':'l','व':'v','श':'sh','ष':'sh','स':'s','ह':'h',
      'क़':'q','ख़':'kh','ग़':'gh','ज़':'z','ड़':'r','ढ़':'rh','फ़':'f','य़':'y',
    };
    const vowels = {
      'अ':'a','आ':'aa','इ':'i','ई':'i','उ':'u','ऊ':'u','ऋ':'ri',
      'ए':'e','ऐ':'ai','ओ':'o','औ':'au','ऍ':'e','ऑ':'o',
    };
    // ALL matras — ा/ी/ू are context-aware (null here, handled below)
    // ं (anusvara) is also null — handled context-aware (m before labials, n otherwise)
    const allMatras = {
      'ा':null, 'ी':null, 'ू':null,
      'ि':'i', 'ु':'u', 'ृ':'ri',
      'े':'e', 'ै':'ai', 'ो':'o', 'ौ':'au',
      'ँ':'n', 'ं':null, 'ः':'h', 'ॅ':'e', 'ॉ':'o',
    };
    // Labial consonants — anusvara (ं) becomes 'm' before these
    const labials = new Set(['प','फ','ब','भ','म','फ़']);
    const halant = '्';

    const isMatra = (ch) => ch && allMatras.hasOwnProperty(ch);
    const isConsonant = (ch) => ch && consonants.hasOwnProperty(ch);

    const chars = Array.from(word);
    const out = [];

    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const next = chars[i + 1];
      const isLast = !next || !/[ऀ-ॿ]/.test(next);

      if (isConsonant(c)) {
        out.push(consonants[c]);

        // If followed by any matra or halant → no implicit 'a'
        if (next && (isMatra(next) || next === halant)) {
          continue;
        }

        // Word-final → drop schwa (Hindi schwa deletion at end only).
        // Internal schwa deletion is word-specific and too risky to
        // automate — the dictionary above handles common words.
        // Keeping internal 'a' is always understandable ("madad" not "mdd").
        if (isLast) continue;

        // Otherwise KEEP implicit 'a'
        out.push('a');
        continue;
      }

      // Context-aware long matras (ा, ी, ू):
      // Inside word → double vowel (baat, theek, phool)
      // Word-final → single vowel (neha, rahi, guru)
      // Context-aware anusvara (ं): 'm' before labials, 'n' otherwise
      // नंबर → nam-bar (not nan-bar), संपर्क → sam-park (not san-park)
      if (c === 'ं') {
        if (next && labials.has(next)) {
          out.push('m');
        } else {
          out.push('n');
        }
        continue;
      }

      // Context-aware long matras (ा, ी, ू):
      // Inside word → double vowel (baat, theek, phool)
      // Word-final → single vowel (neha, rahi, guru)
      if (c === 'ा') { out.push(isLast ? 'a' : 'aa'); continue; }
      if (c === 'ी') { out.push(isLast ? 'i' : 'ee'); continue; }
      if (c === 'ू') { out.push(isLast ? 'u' : 'oo'); continue; }

      // Other matras
      if (isMatra(c) && allMatras[c] !== null) { out.push(allMatras[c]); continue; }
      if (isMatra(c)) continue;

      if (vowels[c]) { out.push(vowels[c]); continue; }
      if (c === halant) continue;
      if (c === '़') continue;

      // Devnagari digits
      if (c >= '०' && c <= '९') {
        out.push(String.fromCharCode(c.charCodeAt(0) - 0x0966 + 0x30));
        continue;
      }
      out.push(c);
    }
    return out.join('');
  }

  /**
   * Native script of an Edge TTS voice, derived from its locale prefix.
   * Indic Edge voices are trained on their NATIVE script and mispronounce
   * Latin/Roman text. So the agent's output script must match the voice.
   * Returns: 'deva' | 'tamil' | 'telugu' | 'kannada' | 'malayalam' |
   *          'gujarati' | 'bengali' | 'gurmukhi' | 'arabic' | 'latin'
   */
  _voiceNativeScript(voiceId = '') {
    const v = String(voiceId || '');
    if (v.startsWith('hi-IN') || v.startsWith('mr-IN')) return 'deva';
    if (v.startsWith('ta-IN')) return 'tamil';
    if (v.startsWith('te-IN')) return 'telugu';
    if (v.startsWith('kn-IN')) return 'kannada';
    if (v.startsWith('ml-IN')) return 'malayalam';
    if (v.startsWith('gu-IN')) return 'gujarati';
    if (v.startsWith('bn-IN')) return 'bengali';
    if (v.startsWith('pa-IN')) return 'gurmukhi';
    if (v.startsWith('ur-IN') || v.startsWith('ur-PK')) return 'arabic';
    return 'latin'; // all en-* and others
  }

  /**
   * The script the agent SHOULD produce for clear TTS, given the language
   * setting and the selected voice.
   *  - hi-Latn / en / en-IN  → 'latin' (Hinglish/English are Roman by design)
   *  - hi / multi / regional → the voice's native script (Devnagari for a
   *    Hindi voice, Tamil for a Tamil voice, etc.)
   */
  _targetScript(lang = 'en', voiceId = '') {
    // hi-Latn and English variants always want Roman (Latin) output
    if (lang === 'hi-Latn' || lang === 'en' || lang === 'en-IN') return 'latin';
    
    // If the language is pure Hindi (lang='hi') or multi:
    // Modern multilingual TTS (ElevenLabs, Cartesia) don't use 'Neural' in their IDs.
    // They support native Devnagari flawlessly, so return 'deva' to prevent transliteration.
    if (voiceId && !voiceId.includes('Neural')) {
      return 'deva';
    }

    // For Edge TTS, fall back to deriving script from locale prefix (hi-IN -> deva, en-IN -> latin)
    return this._voiceNativeScript(voiceId);
  }

  /**
   * Humanize LLM text for natural speech.
   * Adds micro-pauses, forces contractions, formats numbers for speaking,
   * and removes any remaining markdown artifacts.
   */
  humanizeText(text, lang = 'en', targetScript = 'latin') {
    if (!text) return text;
    let t = text;

    // 0. SCRIPT NORMALIZATION — match the TTS voice's native script.
    //    - targetScript 'latin' (English / Hinglish / Roman-Hindi voices):
    //      strip any Devnagari the LLM leaked, since a Roman-script voice
    //      (or our Hinglish design) needs Latin text.
    //    - targetScript 'deva' etc. (native Indic voice): KEEP the native
    //      script. The Hindi voice pronounces Devnagari CLEARLY but garbles
    //      Roman text, so we must NOT transliterate away from it here.
    if (targetScript === 'latin' && /[ऀ-ॿ]/.test(t)) {
      const before = t;
      t = this._transliterateDevnagari(t);
      console.warn(`[humanize] Devnagari leak → Roman (latin voice):\n  before: "${before.slice(0, 120)}"\n  after:  "${t.slice(0, 120)}"`);
    }

    // 1. Force contractions (formal → spoken)
    t = t.replace(/\bI would\b/gi, "I'd");
    t = t.replace(/\bI will\b/gi, "I'll");
    t = t.replace(/\bI am\b/gi, "I'm");
    t = t.replace(/\bI have\b/gi, "I've");
    t = t.replace(/\bdo not\b/gi, "don't");
    t = t.replace(/\bcan not\b/gi, "can't");
    t = t.replace(/\bcannot\b/gi, "can't");
    t = t.replace(/\bwill not\b/gi, "won't");
    t = t.replace(/\bwould not\b/gi, "wouldn't");
    t = t.replace(/\bshould not\b/gi, "shouldn't");
    t = t.replace(/\bcould not\b/gi, "couldn't");
    t = t.replace(/\bit is\b/gi, "it's");
    t = t.replace(/\bthat is\b/gi, "that's");
    t = t.replace(/\bwhat is\b/gi, "what's");
    t = t.replace(/\bthere is\b/gi, "there's");
    t = t.replace(/\bwe are\b/gi, "we're");
    t = t.replace(/\bthey are\b/gi, "they're");
    t = t.replace(/\byou are\b/gi, "you're");
    t = t.replace(/\blet us\b/gi, "let's");
    t = t.replace(/\bhere is\b/gi, "here's");

    // 2. Kill remaining robotic phrases the LLM might slip through
    t = t.replace(/\bCertainly!?\s*/gi, '');
    t = t.replace(/\bAbsolutely!?\s*/gi, 'Sure, ');
    t = t.replace(/\bAdditionally,?\s*/gi, 'Also, ');
    t = t.replace(/\bFurthermore,?\s*/gi, 'And ');
    // Handle full "I'd/would be happy to assist/help [you] [with that]" constructions
    t = t.replace(/\bI'?d be happy to (help|assist)( you)?( with that)?[.,]?\s*/gi, "I'll help. ");
    t = t.replace(/\bI would be happy to (help|assist)( you)?( with that)?[.,]?\s*/gi, "I'll help. ");
    t = t.replace(/Is there anything else I can help you with(\?|\.|!)?/gi, 'Anything else?');
    t = t.replace(/Is there anything else(\?|\.|!)?/gi, 'Anything else?');

    // 3. Long digit sequences → spoken digit-by-digit (phone numbers, account
    //    numbers, OTPs read out as individual digits). Threshold is tunable:
    //    default 7 so that 4-digit years ("2024"), prices ("4500"), and small
    //    quantities are spoken naturally instead of "2, 0, 2, 4". Phone and
    //    account numbers (10+ digits) and 7+ digit codes still get spelled out.
    const digitSpellThreshold = Number(process.env.HUMANIZE_DIGIT_SPELL_MIN || 7);
    t = t.replace(/\b(\d+)\b/g, (match) => {
      if (match.length >= digitSpellThreshold) {
        return match.split('').join(', ');
      }
      return match;
    });

    // 4. Clean excess punctuation
    t = t.replace(/!{2,}/g, '!');
    t = t.replace(/\?{2,}/g, '?');

    // 5. Clean any remaining markdown artifacts
    t = t.replace(/\*+/g, '');
    t = t.replace(/#{1,6}\s/g, '');
    t = t.replace(/^- /gm, '');

    // 6. REMOVE comma-to-ellipsis substitution.
    // The old ",... " trick was meant to add a micro-pause, but it actually:
    //   a) Creates an audible "dot dot dot" breath artifact in Edge TTS
    //   b) Compounds with the sentence-splitter — a comma at split-point
    //      becomes ",... " which the next chunk starts with, producing
    //      "...main check karta hun" spoken as "dot dot dot main check..."
    // Edge TTS already pauses naturally at commas in SSML prosody.
    // So we do NOTHING here — just let the comma be.
    // t = t.replace(/,\s(?!\.)/g, ',... ');  // REMOVED

    // 7. Handle emotional tokens (Phase 3)
    t = t.replace(/\[LAUGH\]/gi, 'haha...');
    t = t.replace(/\[SIGH\]/gi, 'huff...');

    // 8. Hinglish Context Switching (Zoronal Speciality - Phase 4)
    //    Only when we're producing ROMAN text. For a native Devnagari voice
    //    these Roman words would be mispronounced, so skip them.
    if (targetScript === 'latin' && (lang === 'hi' || lang === 'hi-Latn' || lang === 'multi')) {
      t = t.replace(/\b(Yes|Yeah)\b/gi, "Haan");
      t = t.replace(/\b(Okay|Ok)\b/gi, "Theek hai");
      t = t.replace(/\b(Sorry)\b/gi, "Maaf karna");
      t = t.replace(/\brupees\b/gi, "rupaye");
    }

    return t.trim();
  }

  /**
   * Get dynamic TTS pitch variation based on sentence type.
   * Humans naturally raise pitch for questions and vary it for statements.
   * This breaks the monotone "robot reading a script" feel.
   */
  getDynamicPitch(text) {
    const trimmed = (text || '').trim();
    if (trimmed.endsWith('?'))  return 2;  // Questions: +2Hz (slightly higher)
    if (trimmed.endsWith('!'))  return 1;  // Excitement: +1Hz
    // Statements: alternate between -1Hz and 0Hz to prevent metronomic monotone
    return Math.random() > 0.5 ? -1 : 0;
  }

  /**
   * Map detected emotion to a (speedDelta, pitchDelta) prosody adjustment.
   *
   * The agent already detects user emotion (detectEmotion) and biases the
   * LLM. But the TTS voice still spoke the response at a flat baseline
   * speed/pitch — so an angry customer got the same calm cadence as a
   * happy one. That's the "uncanny" gap: words say "I'm so sorry" while
   * the voice sounds chipper.
   *
   * Returns small deltas applied on top of the agent's configured speed
   * and the per-sentence pitch variation. Keep magnitudes conservative —
   * Edge TTS gets weird beyond ±15% rate or ±3Hz pitch.
   */
  getEmotionProsody(userEmotion) {
    switch (userEmotion) {
      case 'angry':
      case 'frustrated': return { speedDelta: -0.05, pitchDelta: -1 }; // slow + lower = calming
      case 'urgent':     return { speedDelta:  0.10, pitchDelta:  0 }; // faster, neutral pitch
      case 'sad':        return { speedDelta: -0.07, pitchDelta: -1 }; // slower, softer
      case 'happy':      return { speedDelta:  0.03, pitchDelta:  1 }; // slightly upbeat
      default:           return { speedDelta:  0,    pitchDelta:  0 };
    }
  }

  getGroqFallbackModels(primaryModel = 'llama-3.1-8b-instant') {
    const envList = (process.env.GROQ_FALLBACK_MODELS || '')
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
    // Verified-alive models on Groq production (decommissioned ones removed):
    // llama-3.1-8b-instant   — fastest (conversation default)
    // llama-3.3-70b-versatile — smarter, slightly slower
    // meta-llama/llama-4-scout-17b-16e-instruct — Llama 4, different family
    // openai/gpt-oss-20b      — different provider for diversity if Llama family rate-limits
    const defaults = [
      'llama-3.1-8b-instant',
      'llama-3.3-70b-versatile',
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'openai/gpt-oss-20b',
    ];
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
  async processText({ text, agent, history = [], userSettings = {}, memory = null, ragContext = '', callContext = {} }) {
    const start = Date.now();

    // Build conversation messages
    const lastReplies = history.filter(m => m.role === 'assistant').slice(-3).map(m => m.content);
    const messages = [
      {
        role: 'system',
        content: this.buildSystemPrompt(agent, memory, ragContext, lastReplies, callContext.vars || {}),
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
    const llmProvider = agent.llm?.provider || 'gemini';
    const llmModel = agent.llm?.model || 'gemini-2.0-flash';
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
          model: llmModel || 'gemini-2.0-flash',
          // Default temperature 0.4 for business voice agents — high creativity
          // (default 0.7) makes Llama drift into long, decorative essays.
          // Tunable via agent.temperature in DB or LLM_DEFAULT_TEMPERATURE env.
          temperature: agent.temperature ?? Number(process.env.LLM_DEFAULT_TEMPERATURE || 0.4),
          apiKey: userSettings.geminiKey || process.env.GEMINI_API_KEY,
        });
      } else {
        // ─── Default: Groq with Gemini auto-fallback ─────────────────────
        llmResponse = await this.generateGroqResponseWithFallback({
          messages,
          model: llmModel,
          // Default temperature 0.4 for business voice agents — high creativity
          // (default 0.7) makes Llama drift into long, decorative essays.
          // Tunable via agent.temperature in DB or LLM_DEFAULT_TEMPERATURE env.
          temperature: agent.temperature ?? Number(process.env.LLM_DEFAULT_TEMPERATURE || 0.4),
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
            const result = await toolExecutor.executeTool({ toolName: fnName, toolInput: args, agentContext: agent, callContext });
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
    if (lang === 'hi') defaultVoiceId = 'hi-IN-SwaraNeural';
    // hi-Latn = Hinglish / Roman-script Hindi. The LLM output gets
    // transliterated to Roman by humanizeText, so we need a LATIN-script
    // voice. hi-IN-SwaraNeural is a Devnagari-trained voice and mispronounces
    // Roman text. en-IN-NeerjaNeural is an Indian English voice that handles
    // Roman/Hinglish naturally — correct accent, correct script.
    else if (lang === 'hi-Latn') defaultVoiceId = 'en-IN-NeerjaNeural';
    else if (lang === 'multi') defaultVoiceId = 'hi-IN-SwaraNeural';
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
    const speed = agent.voice?.speed || 1.05;

    // Humanize LLM output for natural speech
    const targetScript = this._targetScript(lang, voiceId);
    const humanizedResponse = this.humanizeText(responseText, lang, targetScript);
    const pitch = this.getDynamicPitch(humanizedResponse);

    let audioBuffer;
    try {
      audioBuffer = await ttsService.textToSpeech({
        text: humanizedResponse,
        voiceId,
        speed,
        pitch,
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
  async *processTextStream({ text, agent, history = [], userSettings = {}, memory = null, ragContext = '', abortSignal = null, sessionId = null, callContext = {} }) {
    // ── Emotion detection ──────────────────────────────────────────────────
    const currentEmotion = this.detectEmotion(text);
    let emotionPrompt = '';
    if (currentEmotion === 'angry')  emotionPrompt = '\n[SYSTEM DIRECTIVE]: The user seems frustrated or angry. Adopt a highly empathetic, calming, and apologetic tone immediately.';
    if (currentEmotion === 'urgent') emotionPrompt = '\n[SYSTEM DIRECTIVE]: The user has an urgent issue. Be extremely concise, fast, and helpful. Get straight to the point.';

    // ── Rolling conversation summary for long calls ──────────────────────
    // Pass sessionId so the summary is cached + refreshed in the background
    // instead of making a blocking Groq call on every turn (which was
    // starving the reply stream and causing the mid-call latency spiral).
    const { summary: rollingSummary, recentHistory } = await this.compressHistory(history, sessionId, agent);
    let summaryPrompt = '';
    if (rollingSummary) {
      summaryPrompt = `\n\n## EARLIER CONVERSATION SUMMARY:\n${rollingSummary}`;
    }

    // Anti-repetition: feed the last 3 assistant lines into the system
    // prompt so Llama 3.1 8B doesn't echo itself when the user acks.
    const lastReplies = recentHistory.filter(m => m.role === 'assistant').slice(-3).map(m => m.content);

    const messages = [
      { role: 'system', content: '' }, // filled in below once, after KB + tools are resolved
      ...recentHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: text },
    ];

    const llmProvider   = agent.llm?.provider   || 'gemini';
    const llmModel      = agent.llm?.model       || 'gemini-2.0-flash';
    // Default to edge-tts (free, no API key needed).
    // Cartesia is only used when the agent explicitly sets voice.provider = 'cartesia'.
    // Never auto-select Cartesia from env alone — an invalid/expired key causes every
    // TTS call to fail with 401, then retry through the full Edge TTS fallback chain.
    const voiceProvider = agent.voice?.provider || 'edge-tts';
    // Language-aware voice default — must match the target script that humanizeText
    // will produce. hi-Latn outputs Roman text (transliterated), so it needs a
    // Latin-script voice (en-IN-NeerjaNeural). Using a Devnagari voice (hi-IN-*)
    // with Roman input causes garbled/cut pronunciation.
    const streamLang = agent.language || 'en';
    let streamDefaultVoiceId = 'en-US-JennyNeural';
    if      (streamLang === 'hi')      streamDefaultVoiceId = 'hi-IN-SwaraNeural';
    else if (streamLang === 'hi-Latn') streamDefaultVoiceId = 'en-IN-NeerjaNeural';
    else if (streamLang === 'multi')   streamDefaultVoiceId = 'hi-IN-SwaraNeural';
    else if (streamLang === 'en-IN')   streamDefaultVoiceId = 'en-IN-NeerjaNeural';
    else if (streamLang === 'ta')      streamDefaultVoiceId = 'ta-IN-PallaviNeural';
    else if (streamLang === 'te')      streamDefaultVoiceId = 'te-IN-ShrutiNeural';
    else if (streamLang === 'kn')      streamDefaultVoiceId = 'kn-IN-SapnaNeural';
    else if (streamLang === 'ml')      streamDefaultVoiceId = 'ml-IN-SobhanaNeural';
    else if (streamLang === 'mr')      streamDefaultVoiceId = 'mr-IN-AarohiNeural';
    else if (streamLang === 'gu')      streamDefaultVoiceId = 'gu-IN-DhwaniNeural';
    else if (streamLang === 'bn')      streamDefaultVoiceId = 'bn-IN-TanishaaNeural';
    else if (streamLang === 'ur')      streamDefaultVoiceId = 'ur-IN-GulNeural';
    else if (streamLang === 'pa')      streamDefaultVoiceId = 'pa-IN-OjasNeural';
    const voiceId       = agent.voice?.voiceId   || streamDefaultVoiceId;
    const speed         = agent.voice?.speed     || 1.05; // 1.05 = slightly faster than default, sounds more conversational
    // Select the correct default API key based on the voice provider
    let defaultTtsKey = '';
    if (voiceProvider === 'cartesia') defaultTtsKey = process.env.CARTESIA_API_KEY;
    else if (voiceProvider === 'eleven-labs') defaultTtsKey = process.env.ELEVENLABS_API_KEY;
    const ttsApiKey     = userSettings.ttsKey || defaultTtsKey;

    const fastFirstChunkMode       = String(process.env.FAST_FIRST_CHUNK_MODE || 'true').toLowerCase() === 'true';
    // Fast-first-chunk: fire TTS early so the user hears SOMETHING quickly.
    // CRITICAL: firstChunkMaxWords must be large enough that the split point
    // falls at a natural pause — cutting at 8 words produces "Sure, aapka" |
    // "naam aur phone..." which sounds broken. 14 words covers most short
    // sentences fully, so the "fast chunk" IS the complete first sentence.
    // Only very long first sentences get split, and they split cleanly.
    const firstChunkCharThreshold  = Number(process.env.FAST_FIRST_CHUNK_CHAR_THRESHOLD || 30);
    const firstChunkMaxWords       = Number(process.env.FAST_FIRST_CHUNK_MAX_WORDS || 14);

    // ── Dynamic Knowledge (RAG) ────────────────────────────────────────────
    // (Handled via ragContext passed from voiceSession.js Hybrid Search)

    // ── Tool instructions ──────────────────────────────────────────────────
    const toolInstructions = agent.webhooks?.length > 0
      ? `\n[Tool Instructions]: You can call these tools if needed: ${agent.webhooks.map(w => w.name).join(', ')}. Format: <TOOL>function_name(args)</TOOL>`
      : '';

    // Build the system prompt ONCE, including ALL context. Previously this
    // was built twice and the second build OVERWROTE messages[0] — silently
    // discarding the (expensive) rolling summary and the anti-repetition
    // lastReplies. Now everything is composed in a single pass.
    const systemPrompt = this.buildSystemPrompt(agent, memory, ragContext, lastReplies, callContext.vars || {})
      + summaryPrompt
      + toolInstructions
      + emotionPrompt;
    messages[0].content = systemPrompt;

    // ── Instant "thinking" filler to cut PERCEIVED latency ────────────────
    // Research (Vapi/Retell): humans tolerate ~600ms; past that a turn feels
    // laggy. Even when the LLM needs 800-1400ms, an INSTANT acknowledgment
    // ("Hmm...", "Accha...") makes the turn feel responsive. Key: it must add
    // ZERO latency itself, so we only use a CACHE HIT (prewarmed at init).
    // No cache hit → skip silently rather than block on TTS generation.
    const fillerEnabled = agent.advanced?.fillerWords !== false; // default ON
    const fillerProb = Number(process.env.LLM_FILLER_PROBABILITY || 0.5);
    if (fillerEnabled && Math.random() < fillerProb) {
      const lang = agent.language || 'en';
      const fillers = this._fillersByLang[lang] || this._fillersByLang['en'];
      const filler  = fillers[Math.floor(Math.random() * fillers.length)];
      const fillerSpeed = Math.max(0.85, speed - 0.15); // slightly slower = natural "thinking"
      // Cache-only lookup — instant if prewarmed, otherwise we skip the filler
      // entirely so we never ADD latency waiting for TTS synthesis.
      let fillerAudio = null;
      try {
        fillerAudio = ttsService.cache?.get?.(filler, voiceId, fillerSpeed, voiceProvider) || null;
      } catch (_) { fillerAudio = null; }
      if (fillerAudio && fillerAudio.length > 0) {
        yield { type: 'chunk', text: filler + ' ', audio: fillerAudio };
      } else {
        // Warm it in the background for next time — but DON'T await/emit now.
        ttsService.textToSpeech({ text: filler, voiceId, speed: fillerSpeed, apiKey: ttsApiKey, provider: voiceProvider }).catch(() => {});
      }
    }

    // ── Select token stream (Custom URL or Groq with fallback) ────────────
    // Pipeline-level abort: links the caller's interrupt signal with an
    // internal controller we also trigger when the circuit breaker fires or
    // the consumer stops draining early. Without this, an abandoned producer
    // keeps `for await`-ing the Groq stream in the background, holding its
    // connection-pool slot and causing latency to climb across the call.
    const pipelineAbort = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) pipelineAbort.abort();
      else abortSignal.addEventListener('abort', () => {
        try { pipelineAbort.abort(); } catch (_) {}
      }, { once: true });
    }

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
    } else {
      // ─── Gemini & Groq Unified Streaming with Fallbacks ───────────────────
      const apiKey = userSettings[`${llmProvider}Key`] || process.env.GROQ_API_KEY;
      let temperature = agent.advanced?.temperature ?? agent.temperature ?? Number(process.env.LLM_DEFAULT_TEMPERATURE || 0.4);
      if (agent.advanced?.strictGrounding !== false) {
        temperature = Math.min(temperature, 0.1);
      }
      const self = this;

      tokenStream = (async function* () {
        let lastErr = null;

        // 1. Try Gemini first if it's the provider
        if (llmProvider === 'gemini' && geminiService.isAvailable(userSettings.geminiKey)) {
          try {
            const gemStream = geminiService.generateStreamResponse({
              messages,
              model: llmModel || 'gemini-2.0-flash',
              temperature,
              apiKey: userSettings.geminiKey || process.env.GEMINI_API_KEY,
            });
            // Prime stream to catch 429 quota errors immediately
            const first = await gemStream.next();
            if (!first.done) {
              if (first.value) yield first.value;
              for await (const tok of gemStream) {
                if (pipelineAbort.signal.aborted) return;
                yield tok;
              }
              return; // Clean exit
            }
          } catch (gemErr) {
            console.warn(`[LLM Stream] Gemini failed (${gemErr.message}). Falling back to Groq...`);
            lastErr = gemErr;
          }
        }

        // 2. Try Groq (either as primary, or fallback if Gemini failed)
        if (llmProvider === 'groq' || lastErr) {
          const candidateModels = self.getGroqFallbackModels(llmProvider === 'groq' ? llmModel : 'llama-3.1-8b-instant');
          const groqKey = userSettings.groqKey || process.env.GROQ_API_KEY;
          
          for (const modelCandidate of candidateModels) {
            if (pipelineAbort.signal.aborted) return;
            const inner = groqService.generateStreamResponse({
              messages,
              model: modelCandidate,
              temperature,
              apiKey: groqKey,
              abortSignal: pipelineAbort.signal,
            });
            try {
              const first = await inner.next();
              if (first.done) {
                lastErr = new Error(`${modelCandidate}_empty_stream`);
                continue;
              }
              if (first.value) yield first.value;
              for await (const tok of inner) {
                if (pipelineAbort.signal.aborted) return;
                yield tok;
              }
              return;
            } catch (err) {
              lastErr = err;
              console.warn(`[LLM Stream Fallback] Groq ${modelCandidate} failed -> ${err.message} — rotating`);
            }
          }
        }

        // 3. If primary was Groq and all Groq models failed, try Gemini as last resort
        if (llmProvider === 'groq' && lastErr && geminiService.isAvailable(userSettings.geminiKey)) {
          console.log('[LLM Stream Fallback] All Groq models failed. Trying Gemini stream...');
          try {
            const gem = geminiService.generateStreamResponse({ messages, temperature, apiKey: userSettings.geminiKey || process.env.GEMINI_API_KEY });
            const first = await gem.next();
            if (!first.done) {
              if (first.value) yield first.value;
              for await (const tok of gem) {
                if (pipelineAbort.signal.aborted) return;
                yield tok;
              }
              return;
            }
          } catch (gemErr) {
            console.error('[LLM Stream Fallback] Gemini stream failed:', gemErr.message);
            lastErr = gemErr;
          }
        }

        throw lastErr || new Error('all_llm_stream_models_failed');
      })();
    }

    // ═════════════════════════════════════════════════════════════════════
    // CONCURRENT PIPELINE CORE
    // ─────────────────────────────────────────────────────────────────────
    // ttsQueue  : Array<Promise<{text, audio}>>  — ordered TTS jobs
    // producerDone: boolean — signals that the LLM loop has finished
    // producerError: Error|null — any error from the producer
    // ─────────────────────────────────────────────────────────────────────

    /** Helper: kick off TTS without blocking; returns a Promise<{text,audio}> */
    const emotionProsody = this.getEmotionProsody(currentEmotion);
    
    // Concurrency limiter to prevent blowing up ElevenLabs/Edge free tier limits
    let activeTTSCount = 0;
    const ttsWaitQueue = [];
    const MAX_CONCURRENT_TTS = 2; // Very safe limit for free tiers

    const runNextTTS = () => {
      if (ttsWaitQueue.length === 0 || activeTTSCount >= MAX_CONCURRENT_TTS) return;
      activeTTSCount++;
      const { text, resolve, reject } = ttsWaitQueue.shift();
      doFireTTS(text).then(resolve).catch(reject).finally(() => {
        activeTTSCount--;
        runNextTTS();
      });
    };

    const doFireTTS = (sentenceText) => {
      const lang = agent.language || 'en';
      const targetScript = this._targetScript(lang, voiceId);
      const humanized = this.humanizeText(sentenceText, lang, targetScript);
      const dynamicPitch = this.getDynamicPitch(humanized);
      const adjustedSpeed = Math.max(0.7, Math.min(1.6, speed + emotionProsody.speedDelta));
      const adjustedPitch = Math.max(-3, Math.min(3, dynamicPitch + emotionProsody.pitchDelta));
      return ttsService.textToSpeech({ text: humanized, voiceId, speed: adjustedSpeed, pitch: adjustedPitch, apiKey: ttsApiKey, provider: voiceProvider })
        .then(audio => ({ text: humanized, audio }))
        .catch(err  => {
          console.error(`[TTS Concurrent] Failed: "${humanized.substring(0, 40)}"`, err.message);
          return { text: humanized, audio: Buffer.alloc(0) };
        });
    };

    const fireTTS = (sentenceText) => {
      return new Promise((resolve, reject) => {
        ttsWaitQueue.push({ text: sentenceText, resolve, reject });
        runNextTTS();
      });
    };

    const ttsQueue     = [];   // ordered promise array
    let producerDone   = false;
    let producerError  = null;
    let fullResponseText = '';
    let lastTokenTime  = Date.now();

    // ── LLM Producer (runs concurrently; never awaits TTS) ────────────────
    const runProducer = async () => {
      let currentSentence     = '';
      let hasSpokenFirstChunk = false;

      try {
        for await (const token of tokenStream) {
          if (pipelineAbort.signal.aborted) break;
          lastTokenTime = Date.now();
          fullResponseText  += token;
          currentSentence   += token;

          // ── Tool Execution (Vapi/Retell style) ──────────────────────────
          if (fullResponseText.includes('<TOOL>') && fullResponseText.includes('</TOOL>')) {
            const toolMatch = fullResponseText.match(/<TOOL>(.*?)<\/TOOL>/);
            if (toolMatch) {
              const toolCallStr = toolMatch[1];
              const name        = toolCallStr.split('(')[0];
              const argsStr     = toolCallStr.match(/\((.*?)\)/)?.[1] || '{}';
              
              // Tell user we are looking it up (instantly)
              const lang = agent.language || 'en';
              const checkPhrases = {
                'en': 'Let me check that real quick...',
                'hi': 'Ek minute rukiye, main check karti hoon...',
                'hi-Latn': 'Ek minute rukiye, main check karti hoon...',
                'multi': 'Ek second...',
                'en-IN': 'Just a moment, let me check...'
              };
              const checkPhrase = checkPhrases[lang] || checkPhrases['en'];
              ttsQueue.push(fireTTS(checkPhrase));

              try {
                const args       = JSON.parse(argsStr.replace(/'/g, '"'));

                // Prevent circuit breaker from tripping during long tool execution
                let isToolRunning = true;
                const keepAliveTimer = setInterval(() => { if (isToolRunning) lastTokenTime = Date.now(); }, 1000);

                // Hard timeout: if a tool hangs longer than TOOL_EXECUTION_TIMEOUT_MS,
                // bail with an error result so the LLM can recover. Default 10s — long
                // enough for most webhooks (Zapier, n8n, Slack), short enough that the
                // user doesn't think the agent died.
                const toolTimeoutMs = Number(process.env.TOOL_EXECUTION_TIMEOUT_MS || 10000);
                let toolResult;
                try {
                  toolResult = await Promise.race([
                    toolExecutor.executeTool({ toolName: name, toolInput: args, agentContext: agent, callContext }),
                    new Promise((_, reject) => setTimeout(
                      () => reject(new Error(`tool_timeout_${toolTimeoutMs}ms`)),
                      toolTimeoutMs
                    )),
                  ]);
                } catch (toolErr) {
                  console.error(`[Tool Timeout/Error] ${name}: ${toolErr.message}`);
                  toolResult = { success: false, tool: name, error: toolErr.message };
                } finally {
                  isToolRunning = false;
                  clearInterval(keepAliveTimer);
                }

                if (toolResult.result?.__transferToAgentId) {
                  // Enqueue a special sentinel so the drainer can yield the transfer event
                  ttsQueue.push(Promise.resolve({
                    __special: 'transfer_agent',
                    agentId:   toolResult.result.__transferToAgentId,
                    reason:    toolResult.result.reason,
                  }));
                  return; // Stop producing
                }

                // Emit a tool.called sentinel so subscribers (voiceSession
                // → serverEventsDispatcher) can fire a webhook in real time.
                ttsQueue.push(Promise.resolve({
                  __special: 'tool_called',
                  toolName: name,
                  args:     argsStr,
                  result:   toolResult,
                }));

                console.log('[Tool Executed] Result:', toolResult);
                fullResponseText = fullResponseText.replace(toolMatch[0], ` [Result: ${JSON.stringify(toolResult)}] `);
              } catch (e) {
                console.error('Tool parsing failed:', e.message);
              }
            }
          }

          // ── Fast-first-chunk: fire TTS before sentence boundary ─────────
          // Goal: user hears first audio within ~300-400ms.
          // Strategy: wait until we have enough content (30+ chars) AND then
          // split ONLY at a natural boundary (comma, clause end, or word limit).
          // Splitting mid-word or too early sounds clipped/robotic.
          if (fastFirstChunkMode && !hasSpokenFirstChunk && currentSentence.trim().length >= firstChunkCharThreshold) {
            const words          = currentSentence.trim().split(/\s+/).filter(Boolean);

            // Prefer splitting at a natural clause boundary within the first chunk
            // so "Sure, main check karta hun" → first chunk = "Sure, main check karta hun"
            // rather than cutting arbitrarily at word 14.
            let firstChunkText = '';
            let remainder = '';

            if (words.length <= firstChunkMaxWords) {
              // Short enough to send whole — don't split at all, wait for sentence end.
              // (This avoids the "Sure, aapka" | "naam..." split for short sentences.)
              // Fall through to sentence-boundary chunking below.
            } else {
              // Long sentence: split at firstChunkMaxWords boundary
              firstChunkText = words.slice(0, firstChunkMaxWords).join(' ').trim();
              remainder      = words.slice(firstChunkMaxWords).join(' ').trim();
            }

            if (firstChunkText.length > 0) {
              ttsQueue.push(fireTTS(firstChunkText)); // fire immediately, don't await
              hasSpokenFirstChunk = true;
              currentSentence     = remainder; // CRITICAL: Do not append ' ' here, it breaks partially streamed words!
              console.log(`[Pipeline] Fast-chunk TTS fired (queue=${ttsQueue.length}): "${firstChunkText.substring(0, 60)}"`);
            }
          }

          // ── Phase 2: Sentence-boundary Chunking ──
          // ONLY split on TRUE sentence endings (.!?\n), NOT on commas.
          // Comma splits create audible stitching gaps between Edge TTS chunks
          // because each chunk is a separate WebSocket synthesis request.
          // A natural sentence plays smoothly in one go; comma-split fragments
          // sound like two people talking back-to-back with a micro-gap between.
          // Example: "Sure, main check karta hun." → ONE chunk (natural)
          //          vs "Sure," + "main check karta hun." → TWO chunks (gap audible)
          const isSentenceBoundary = /[.!?\n]/.test(token);

          // Minimum sentence length before we split — too-short first chunks
          // ("Sure.") sound clipped. 18 chars ≈ 3-4 words minimum.
          const minChunkLen = Number(process.env.PIPELINE_MIN_CHUNK_CHARS || 18);

          if (isSentenceBoundary && currentSentence.trim().length >= minChunkLen) {
            const sentenceToSpeak = currentSentence.trim();
            currentSentence = '';
            ttsQueue.push(fireTTS(sentenceToSpeak)); // fire immediately, don't await
            console.log(`[Pipeline] Sentence chunk fired (queue=${ttsQueue.length}): "${sentenceToSpeak.substring(0, 60)}"`);
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
          
          // ── Circuit Breaker: Stop if LLM is stuck for >Ns ──
          // Progressive timeout — fail FAST before first chunk so Gemini
          // fallback kicks in quickly, but be patient mid-stream so slow
          // Hindi/Hinglish/Llama-70B responses don't get cut off.
          //   pre-first-chunk: LLM_PRECHUNK_HANG_TIMEOUT_MS  (default 3000ms)
          //   mid-stream:      LLM_STREAM_HANG_TIMEOUT_MS    (default 6000ms)
          const preChunkTimeoutMs = Number(process.env.LLM_PRECHUNK_HANG_TIMEOUT_MS || 3000);
          const midStreamTimeoutMs = Number(process.env.LLM_STREAM_HANG_TIMEOUT_MS || 6000);
          const hangTimeoutMs = hasEmittedAnyChunk ? midStreamTimeoutMs : preChunkTimeoutMs;
          if (Date.now() - lastTokenTime > hangTimeoutMs) {
            console.error(`[Circuit Breaker] LLM stream hung for >${hangTimeoutMs}ms (${hasEmittedAnyChunk ? 'mid-stream' : 'pre-first-chunk'}). Aborting.`);
            producerError = new Error("LLM_TIMEOUT");
            producerDone = true;

            // Abort the underlying LLM request so the producer's background
            // `for await` stops pulling and releases its connection-pool slot.
            // Without this the orphaned stream keeps draining and head-of-line
            // blocks the very fallback request we're about to make.
            try { pipelineAbort.abort(); } catch (_) {}

            if (!hasEmittedAnyChunk) {
               // If it hung before even speaking, break completely to trigger the Fallback Engine (Gemini)
               break;
            } else {
               // If it hung mid-sentence, apologize
               yield { type: 'chunk', text: "Sorry, my connection dropped for a second.", audio: Buffer.alloc(0) };
               break;
            }
          }

          // Briefly yield control so the producer can push more items
          await new Promise(resolve => setTimeout(resolve, 20));
          continue;
        }

        const result = await ttsQueue[drainIdx++];

        // Handle special sentinel (transfer event)
        if (result.__special === 'transfer_agent') {
          await producerPromise;
          yield { type: 'transfer_agent', agentId: result.agentId, reason: result.reason };
          return;
        }

        // Handle tool.called sentinel — yield to voiceSession so it can
        // fire a real-time server event, then continue draining.
        if (result.__special === 'tool_called') {
          yield { type: 'tool_called', toolName: result.toolName, args: result.args, result: result.result };
          continue;
        }

        yield { type: 'chunk', text: result.text, audio: result.audio };
        hasEmittedAnyChunk = true;
      }

      await producerPromise; // ensure producer has fully exited

      if (producerError && !hasEmittedAnyChunk) throw producerError;

      yield { type: 'final', fullText: fullResponseText };

    } catch (streamErr) {
      await producerPromise.catch(() => {});

      // ── Abort path: the caller (interrupt / new turn / session end)
      //    cancelled this generation. This is NOT a failure — do NOT spin up
      //    a non-stream fallback. Doing so was the root cause of the latency
      //    spiral: an interrupt aborted the stream, the pipeline fired a
      //    zombie fallback Groq request that held a connection slot, and the
      //    real (new) turn then timed out behind it (groq_completion_timeout).
      //    NOTE: we check the EXTERNAL abortSignal specifically — the circuit
      //    breaker aborts the internal pipelineAbort on a genuine hang, and
      //    that case SHOULD still fall through to Gemini / canned reply.
      if (abortSignal?.aborted) {
        console.log('[Pipeline] Generation aborted by caller (interrupt/new turn) — no fallback.');
        return;
      }

      if (hasEmittedAnyChunk) throw streamErr;

      // ── Last-resort fallback ─────────────────────────────────────────────
      // By the time we get here the streaming wrapper has ALREADY rotated
      // through every Groq model AND tried Gemini (if enabled) and they all
      // failed — almost always because the free-tier token bucket (6000 TPM)
      // is momentarily empty. Retrying the same Groq models here just adds
      // 4-8s of dead air. So we do ONE cheap thing: if Gemini is enabled try
      // a single non-stream Gemini call (different provider, separate quota),
      // otherwise go straight to the canned reply that keeps the call alive.
      console.warn('[Pipeline] Stream chain exhausted — using last-resort fallback');

      let fallbackResponse;
      if (geminiService.isAvailable(userSettings.geminiKey)) {
        try {
          fallbackResponse = await geminiService.generateResponse({
            messages,
            model: 'gemini-2.0-flash',
            temperature: agent.temperature ?? Number(process.env.LLM_DEFAULT_TEMPERATURE || 0.4),
            apiKey: userSettings.geminiKey || process.env.GEMINI_API_KEY,
          });
        } catch (e) {
          console.error('[Pipeline] Gemini last-resort failed too:', e.message);
        }
      }

      // Last-resort: cache + intent templates so the call stays alive
      // even when both Groq and Gemini are rate-limited or down.
      let fallbackText;
      if (fallbackResponse?.text) {
        fallbackText = fallbackResponse.text.trim();
      } else {
        const lastResort = llmFallback.getReply(text, agent);
        fallbackText = lastResort.text;
        console.warn(`[Pipeline] Last-resort fallback (${lastResort.source}): "${fallbackText}"`);
      }

      const fallbackAudio = await ttsService.textToSpeech({
        text: fallbackText, voiceId, speed, apiKey: ttsApiKey, provider: voiceProvider,
      });

      yield { type: 'chunk', text: fallbackText,  audio: fallbackAudio };
      yield { type: 'final', fullText: fallbackText };
    } finally {
      // Remember successful responses for future fallback cache hits.
      // Only remember non-trivial replies so we don't poison the cache
      // with apologies or empty strings.
      if (fullResponseText && fullResponseText.trim().length > 10) {
        try { llmFallback.remember(text, fullResponseText.trim()); } catch (_) {}
      }
    }
  }

  /**
   * Post-call analysis (Enhanced — Summary, Sentiment, Topics, Decisions, Intent, Urgency)
   *
   * Optional `agent.extractionSchema` extends the default extractedData
   * shape with custom typed fields (e.g. productInterest:enum, budget:number).
   */
  async analyzeCall(transcript, agent = null) {
    if (!transcript || transcript.length === 0) return null;

    const formattedTranscript = transcript.map(m => `${m.role}: ${m.content}`).join('\n');

    // Build the extractedData schema description. Always includes the
    // built-in PII fields (name/email/phone/company/date) for backwards
    // compatibility, then appends agent-defined custom fields.
    const customFields = Array.isArray(agent?.extractionSchema) ? agent.extractionSchema : [];
    const customFieldDescriptions = customFields.map(f => {
      const t = f.type || 'string';
      const desc = f.description ? ` // ${f.description}` : '';
      const enumPart = (t === 'enum' && Array.isArray(f.enumValues) && f.enumValues.length > 0)
        ? ` (one of: ${f.enumValues.join(', ')})`
        : '';
      const requiredPart = f.required ? ' [REQUIRED]' : '';
      return `        "${f.name}": <${t}${enumPart}>${requiredPart}${desc}`;
    }).join(',\n');

    const extractedDataBlock = customFieldDescriptions
      ? `{
        "name": "",
        "email": "",
        "phone": "",
        "company": "",
        "date": "",
${customFieldDescriptions}
      }`
      : `{ "name": "", "email": "", "phone": "", "company": "", "date": "" }`;

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
        "extractedData": ${extractedDataBlock},
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
      const parsed = JSON.parse(cleanJson);

      // Validate custom enum fields — drop any that don't match allowed values
      // so we never persist garbage from a hallucinating LLM.
      if (customFields.length > 0 && parsed.extractedData) {
        for (const f of customFields) {
          if (f.type === 'enum' && Array.isArray(f.enumValues) && parsed.extractedData[f.name]) {
            const v = String(parsed.extractedData[f.name]);
            if (!f.enumValues.includes(v)) delete parsed.extractedData[f.name];
          }
          if (f.type === 'number' && parsed.extractedData[f.name] != null) {
            const num = Number(parsed.extractedData[f.name]);
            parsed.extractedData[f.name] = Number.isFinite(num) ? num : null;
          }
          if (f.type === 'boolean' && parsed.extractedData[f.name] != null) {
            const v = parsed.extractedData[f.name];
            parsed.extractedData[f.name] = (v === true) || (typeof v === 'string' && /^(true|yes|haan)$/i.test(v));
          }
        }
      }

      return parsed;
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
  async compressHistory(history, sessionId = null, agent = null) {
    if (!history || history.length <= this._summaryThreshold) {
      return { summary: null, recentHistory: history };
    }

    const olderMessages = history.slice(0, history.length - this._summaryKeepRecent);
    const recentHistory = history.slice(-this._summaryKeepRecent);

    // ── Cached path (default) ───────────────────────────────────────────
    // The summary is EXPENSIVE (re-sends the whole older history to Groq).
    // Firing it on every turn floods the free-tier token-per-minute limit
    // and starves the actual reply stream — that was the real cause of the
    // mid-call latency spiral (9-10s). Instead we cache per session and
    // recompute in the BACKGROUND only every N new older-messages, never
    // blocking the turn.
    if (sessionId) {
      const cached = this._summaryCache.get(sessionId);
      const olderCount = olderMessages.length;

      // Decide if a (background) refresh is due.
      const needsRefresh = !cached || (olderCount - cached.coveredCount) >= this._summaryRecomputeEvery;
      if (needsRefresh && !cached?.inFlight) {
        // Mark in-flight on the existing entry (or seed a new one) so we
        // don't launch multiple concurrent summary calls.
        const seed = cached || { summary: null, coveredCount: 0, inFlight: false };
        seed.inFlight = true;
        this._summaryCache.set(sessionId, seed);

        // Fire-and-forget — do NOT await. The current turn uses whatever
        // summary we already have (possibly null on the very first overflow).
        this._computeSummary(olderMessages, agent?.llm?.provider || 'gemini')
          .then((summary) => {
            this._summaryCache.set(sessionId, { summary, coveredCount: olderCount, inFlight: false });
            console.log(`[Rolling Summary] (bg) refreshed for ${sessionId}: covered ${olderCount} older msgs`);
          })
          .catch((e) => {
            const prev = this._summaryCache.get(sessionId) || seed;
            prev.inFlight = false;
            this._summaryCache.set(sessionId, prev);
            console.error('[Rolling Summary] (bg) failed:', e.message);
          });
      }

      // Always return immediately with whatever summary we have cached.
      // If we don't have a summary yet, fall back to a larger recent history (up to 20 msgs)
      // so we don't create a "blind spot" for the LLM while the summary generates.
      return { 
        summary: cached?.summary || null, 
        recentHistory: cached?.summary ? recentHistory : history.slice(-Math.max(this._summaryKeepRecent, 20))
      };
    }

    // ── Legacy synchronous path (no sessionId provided) ─────────────────
    // Kept for callers like squad-handoff that need a one-shot summary.
    try {
      const summary = await this._computeSummary(olderMessages);
      console.log(`[Rolling Summary] Compressed ${olderMessages.length} older messages into summary`);
      return { summary, recentHistory };
    } catch (e) {
      console.error('[Rolling Summary] Failed:', e.message);
      return { summary: null, recentHistory: history.slice(-10) };
    }
  }

  /** Run the actual summary LLM call. Separated so it can run in background. */
  async _computeSummary(olderMessages, llmProvider = 'gemini') {
    const olderFormatted = olderMessages.map(m => `${m.role}: ${m.content}`).join('\n');
    const params = {
      messages: [
        {
          role: 'system',
          content: 'Summarize this call conversation in 3-5 bullet points. Include key facts, decisions, and any data mentioned (names, numbers, dates). Be concise. Respond with ONLY the summary, no preamble.',
        },
        { role: 'user', content: olderFormatted },
      ],
      model: llmProvider === 'gemini' ? 'gemini-2.0-flash' : 'llama-3.1-8b-instant',
      temperature: 0.1,
    };
    
    let response;
    if (llmProvider === 'gemini' && geminiService.isAvailable()) {
      response = await geminiService.generateResponse(params);
    } else {
      response = await groqService.generateResponse(params);
    }
    
    return (response.text || '').trim();
  }

  /** Drop a session's cached summary when its call ends. */
  clearSummaryCache(sessionId) {
    if (sessionId) this._summaryCache.delete(sessionId);
  }

  /**
   * Build system prompt for the agent
   *
   * `lastReplies` = last 2-3 assistant responses. Used to bias the LLM
   * away from saying the same line twice — Llama 3.1 8B has a strong
   * tendency to repeat itself when the user gives a short ack ("ok",
   * "haan"). Showing it the recent assistant lines as a "do not repeat"
   * directive cuts repetition rate dramatically with no latency cost.
   */
  buildSystemPrompt(agent, memory = null, ragContext = '', lastReplies = [], vars = {}) {
    const lang = agent.language || 'en';
    // langInstruction MUST match the targetScript logic:
    // - hi-Latn (Hinglish): Roman script → tell LLM to write in Roman
    // - hi (pure Hindi): Devnagari voice → tell LLM to write in Devnagari
    // - BUG WAS: 'hi' was also forced to ROMAN, which made hi-IN-SwaraNeural
    //   (a native Devnagari voice) receive garbled transliterated text → bad pronunciation
    const langInstruction = lang === 'en'
      ? 'English'
      : lang === 'hi'
        ? 'Hindi (देवनागरी / Devnagari script ONLY. Do NOT romanize Hindi words.)'
        : lang === 'hi-Latn'
          ? 'Hinglish (Hindi in Roman script ONLY — no Devnagari)'
          : lang === 'multi'
            ? 'the same language the user speaks in (use Roman script for Hindi, native script for other languages)'
            : lang;

    // Resolve {{placeholders}} in the (possibly template-derived) system prompt
    // so the model never sees a literal "{{company}}".
    const resolvedSystemPrompt = this.substituteVariables(agent.systemPrompt || '', vars);

    // Persona block first (sets identity), then domain context, then
    // voice constraints LAST. Llama 3.x has strong recency bias —
    // whatever's at the end dominates the response. Putting voice rules
    // last is what stops the model from drifting into helpful-essay mode.
    let prompt = `You are "${agent.name}", a real person on a live phone call.

## YOUR ROLE & PERSONA:
${resolvedSystemPrompt}

## CONVERSATIONAL STYLE (CRITICAL):
- Speak naturally like a human on a phone call. Use simple, everyday language.
- DO NOT use any Markdown formatting. NO asterisks (*), NO bold text (**), NO hashtags (#), and NO bullet points (-).
- Keep your responses concise and to the point. Avoid long essays.
- Do not sound robotic or use overly formal AI-like phrases (e.g. "I am an AI", "As an AI language model").
`;

    if (agent.transferToAgentId) {
      prompt += `\n- If the user needs help you cannot provide, use the "transfer_to_agent" tool with agentId "${agent.transferToAgentId}".`;
    }

    if (memory && memory.facts?.length > 0) {
      const factsStr = memory.facts.map(f => `- ${f.content}`).join('\n');
      prompt += `\n\n## CALLER MEMORY (previous interactions):\n${factsStr}`;
    }

    if (ragContext) {
      prompt += `\n\n## KNOWLEDGE BASE CONTEXT:
Use the following information to answer the user's questions. 
CRITICAL: You must incorporate this knowledge naturally into your assigned ROLE & PERSONA above. Do not break character. Do not explicitly say "According to the knowledge base", just answer as if you naturally know it.
${ragContext}`;
    }

    // ── STRICT GROUNDING (Vapi/Retell guardrails) ──────────────────────────
    // Default ON. Forces the agent to answer ONLY from its system prompt +
    // knowledge base, refuse to invent facts, and not ask for info it doesn't
    // need. Can be disabled per-agent via advanced.strictGrounding = false.
    const strictGrounding = agent.advanced?.strictGrounding !== false;
    if (strictGrounding) {
      const hasKb = !!ragContext;
      const refusalLang = lang === 'en'
        ? `"I'm sorry, I don't have that information right now."`
        : `"Maaf kijiye, mere paas is baare mein abhi jaankari nahi hai."`;
      prompt += `

## STRICT KNOWLEDGE BOUNDARY (CRITICAL — follow EXACTLY):
- Your ONLY source of truth is: (1) Your Role/Persona above${hasKb ? ', and (2) the Knowledge Base Context provided above' : ''}. 
- You have ZERO general knowledge. You know NOTHING beyond what is written above.
- If the user asks something NOT covered in your role${hasKb ? ' or knowledge base' : ''}, you MUST say ${refusalLang}. Then offer to take a message or connect to a human.
- NEVER guess, assume, or use outside/general/world knowledge — even if you "know" the answer. You are a phone agent, not a search engine.
- NEVER invent: prices, dates, names, policies, availability, phone numbers, addresses, locations, timings, or ANY facts not explicitly given to you.
- NEVER assume you have the user's name, phone number, or details unless they explicitly state them. If the user says "Yes, you can take my number", you MUST reply asking them to actually speak the digits out loud.
- If the user asks for specific locations, branches, offices, or entities that are NOT in your Knowledge Base, you MUST use your standard refusal: ${refusalLang}. Do NOT guess or list random locations.
- Do NOT volunteer extra information the user didn't ask for.
- Do NOT ask for information you don't need to fulfill your defined role.
- Stay strictly on-topic. If asked something completely off-topic, politely say: "Main sirf ${agent.name || 'is service'} ke baare mein baat kar sakti hoon." and redirect.
- If user insists on off-topic info, DO NOT give in. Repeat your refusal politely but firmly.`;
    }

    // Anti-repetition guard. Llama 3.1 8B in voice mode repeats its own
    // last line when the user gives a short ack ("ok", "haan", "right").
    // Showing the model exactly what it just said and naming the failure
    // mode is the cheapest fix — costs ~30 tokens, zero latency.
    if (lastReplies && lastReplies.length > 0) {
      const recent = lastReplies
        .filter(r => r && r.length > 5)
        .slice(-3)
        .map((r, i) => `${i + 1}. "${r.trim().slice(0, 140)}"`)
        .join('\n');
      if (recent) {
        prompt += `\n\n## YOU JUST SAID — DO NOT REPEAT:\n${recent}\nRephrase or move forward. Don't echo the same line back when the user gives a short ack.`;
      }
    }

    // VOICE CONSTRAINTS LAST — recency bias makes these dominate behavior.
    // Kept tight on purpose: every token here is re-sent on EVERY turn and
    // Groq's free tier is only 6000 tokens/minute. A bloated prompt burns the
    // budget in ~4 turns and then requests throttle/hang. Few-shot pairs are
    // trimmed to the highest-signal ones.

    // Script rule + few-shot must MATCH the TTS voice. A native Devnagari
    // Hindi voice pronounces Devnagari clearly but garbles Roman text; a
    // Roman/English voice is the opposite. So we flip the instruction based
    // on the voice's native script.
    const voiceId = agent.voice?.voiceId || '';
    const targetScript = this._targetScript(lang, voiceId);

    const scriptRules = {
      deva: {
        rule: `8. SCRIPT (critical): Write Hindi in DEVNAGARI script (देवनागरी). Your voice is a native Hindi voice and pronounces Devnagari clearly. Keep English brand/tech words in Roman (e.g. "website", "booking"). Do NOT romanize Hindi words.`,
        example: `Example:
USER: "मुझे gym ke liye website banwani hai"
YOU: "ज़रूर, जिम के लिए website बन जाएगी। Basic जानकारी चाहिए या booking भी?"
USER: "Pricing kya hai?"
YOU: "Pricing project पर depend करती है। आपको कौन से features चाहिए?"`,
      },
      latin: {
        rule: `8. SCRIPT (critical): NEVER output Devnagari/Indic script even if the user does. Write Hindi in ROMAN script ("विद्यापीठ"→"Vidyapeeth"). Devnagari breaks this voice's TTS.`,
        example: `Example:
USER: "मुझे gym ke liye website banwani hai"
YOU: "Sure, gym ke liye website ban jaayegi. Basic info chahiye ya booking bhi?"
USER: "Pricing kya hai?"
YOU: "Pricing project pe depend karti hai. Aapko kaunse features chahiye?"`,
      },
    };
    // Regional native scripts (Tamil/Telugu/etc.) — keep their own script.
    const nativeScriptRule = `8. SCRIPT (critical): Write in the NATIVE script of your language (matching your voice). Keep English brand/tech words in Roman. Do NOT romanize native words — this voice pronounces its native script clearly.`;

    const chosen = scriptRules[targetScript] || (targetScript === 'latin'
      ? scriptRules.latin
      : { rule: nativeScriptRule, example: '' });

    prompt += `

## VOICE RULES (you are on a live phone call — NOT writing text):
1. LENGTH: 1-2 short sentences max. Never list features; ask ONE qualifying question.
2. NO markdown, bullets, dashes, asterisks. Spoken audio only.
3. NO robotic openers ("Certainly", "I'd be happy to help"). Use "Sure", "Haan", "Theek hai", "Got it".
4. Contractions always: don't, I'll, you're, that's.
5. Phone numbers/OTPs: say digits separately. Emails: "name at gmail dot com".
6. If unsure: never invent details — say you'll confirm.
7. LANGUAGE: reply in ${langInstruction}. Match the user's code-switching.
${chosen.rule}

${chosen.example}

Today is ${new Date().toDateString()}. You are NOT an AI; never say "As an AI".
`;

    return prompt;
  }

  /**
   * Check if user wants to end the call.
   *
   * CRITICAL: this must be HIGH-PRECISION. A false positive hangs up on a
   * paying customer mid-conversation. The old version used substring
   * `includes()` which matched "bas" inside "Basic", "stop" inside "stopped",
   * and treated conversational fillers ("theek hai", "namaste", "shukriya",
   * "dhanyavaad") as hangups — all of which fire constantly during a normal
   * call. We saw exactly this: user said "Basic inko chahiye bas" and the
   * agent said "Goodbye!" and dropped the call.
   *
   * New approach:
   *   - match WHOLE words/phrases only (word boundaries), not substrings
   *   - only genuinely unambiguous hangup intents
   *   - conversational acks are NOT end-call triggers
   */
  shouldEndCall(text, agent) {
    const raw = String(text || '').toLowerCase().trim();
    if (!raw) return false;

    // Normalize: strip punctuation to bare words for whole-word matching.
    const normalized = ` ${raw.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()} `;

    // Unambiguous single-word hangups (matched as whole words).
    const endWords = [
      'goodbye', 'bye', 'alvida',
      // NOTE: deliberately NOT including: bas, stop, theek, namaste,
      // dhanyavaad, shukriya, ok, okay — these occur in normal conversation.
    ];
    // Multi-word hangup phrases (clear intent to end).
    const endPhrases = [
      'hang up', 'end call', 'end the call', 'cut the call',
      'bye bye', 'good bye',
      'call band karo', 'call band kar do', 'band karo call',
      'phone rakho', 'phone rakhta hoon', 'phone rakhti hoon',
      'rakhta hoon', 'rakhti hoon', 'baat khatam',
      'call kaat do', 'kaat do', 'call disconnect',
    ];

    const agentEndPhrases = (agent.endCallPhrases || []).map(p => String(p).toLowerCase());

    // Whole-word match for single words.
    for (const w of endWords) {
      if (normalized.includes(` ${w} `)) return true;
    }
    // Phrase match (these are specific enough that substring is safe).
    for (const p of [...endPhrases, ...agentEndPhrases]) {
      if (p && raw.includes(p)) return true;
    }
    return false;
  }

  /**
   * Substitute {{var}} placeholders with provided values, and strip any
   * placeholders that remain unfilled so the agent never speaks a literal
   * "{{company}}". Used for firstMessage and systemPrompt — template agents
   * ship with placeholders that must resolve (from campaign vars / call params)
   * or be removed before TTS.
   */
  substituteVariables(text, vars = {}) {
    if (!text || typeof text !== 'string') return text || '';
    return text
      .replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, key) => {
        const v = vars[key];
        return v !== undefined && v !== null && String(v).length > 0 ? String(v) : '';
      })
      // Collapse the double spaces / dangling punctuation left where an empty
      // placeholder used to be (e.g. "from  ." → "from.").
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([.,!?])/g, '$1')
      .trim();
  }

  /**
   * Get the agent's first message as audio
   */
  async getFirstMessageAudio(agent, vars = {}) {
    const rawText = agent.firstMessage || 'Hello! How can I help you today?';
    const text = this.substituteVariables(rawText, vars);
    
    const lang = agent.language || 'en';
    let defaultVoiceId = 'en-US-JennyNeural';
    if (lang === 'hi') defaultVoiceId = 'hi-IN-SwaraNeural';
    // hi-Latn = Hinglish / Roman-script Hindi. The LLM output gets
    // transliterated to Roman by humanizeText, so we need a LATIN-script
    // voice. hi-IN-SwaraNeural is a Devnagari-trained voice and mispronounces
    // Roman text. en-IN-NeerjaNeural is an Indian English voice that handles
    // Roman/Hinglish naturally — correct accent, correct script.
    else if (lang === 'hi-Latn') defaultVoiceId = 'en-IN-NeerjaNeural';
    else if (lang === 'multi') defaultVoiceId = 'hi-IN-SwaraNeural';
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
    const speed = agent.voice?.speed || 1.05;

    // Humanize the greeting text exactly like processTextStream does —
    // this is critical for hi-Latn agents whose firstMessage may contain
    // Devnagari characters. Edge TTS for a Latin-script voice will produce
    // silence / empty audio if sent raw Devnagari; humanizeText
    // transliterates it to Roman so the voice can speak it clearly.
    const targetScript = this._targetScript(lang, voiceId);
    const humanizedText = this.humanizeText(text, lang, targetScript);

    try {
      const audioBuffer = await ttsService.textToSpeech({ text: humanizedText, voiceId, speed, provider });
      return { text, audioBuffer };
    } catch (error) {
      console.error('[getFirstMessageAudio] TTS failed:', error.message);
      return { text, audioBuffer: Buffer.alloc(0) };
    }
  }
}

module.exports = new VoicePipeline();
