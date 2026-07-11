/**
 * Safe patch: Replaces VOICE RULES section using line-number slicing.
 * More reliable than string matching with CRLF complications.
 */
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'services', 'voicePipeline.js');
const content = fs.readFileSync(filePath, 'utf8');
const lines = content.split(/\r?\n/);

// Find the exact lines to replace
const startMarker = '## VOICE RULES (you are on a live phone call';
const endMarker = "Today is ${new Date().toDateString()}. You are NOT an AI; never say \"As an AI\".";

let startLine = -1, endLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes(startMarker)) startLine = i;
  if (lines[i].includes(endMarker)) { endLine = i; break; }
}

if (startLine < 0 || endLine < 0) {
  console.error('❌ Could not find markers. startLine:', startLine, 'endLine:', endLine);
  process.exit(1);
}

console.log(`Found VOICE RULES: lines ${startLine+1}–${endLine+1}`);

const newRules = `## VOICE RULES (you are on a live phone call — NOT writing text):
1. RESPOND LIKE A REAL HUMAN ON A PHONE CALL: Warm acknowledgment first ("Zaroor!", "Bilkul!", "Haan ji!", "Achha!"), then give ONE useful piece of info, then ask ONE question. NEVER dump multiple facts at once — drip-feed across turns like a real person.
2. LENGTH (CRITICAL — robotic killer): MAX 15-20 WORDS per response. Short = natural. Long = robotic monologue. Split info across turns.
3. NO markdown, bullets, dashes, asterisks, numbered lists. Spoken audio only.
4. NO robotic openers ("Certainly!", "Of course!", "Great question!", "I'd be happy to help"). Natural Hindi: "Zaroor!", "Bilkul!", "Haan ji!", "Theek hai!", "Achha!".
5. Contractions always: don't, I'll, you're, that's.
6. Phone numbers/OTPs: say digits separately. Emails: "name at gmail dot com".
7. If unsure: never invent details — say you'll confirm.
8a. HINDI VOICE VOCABULARY: Everyday conversational Hindi ONLY. FORBIDDEN:
   - "निम्नलिखित" → use "ये" or list naturally
   - "उपर्युक्त" → use "ऊपर बताए गए"
   - "कृपया ध्यान दें" every turn → only when genuinely important
   - Same opener every time: vary "हाँ जी", "बिल्कुल", "ठीक है", "अच्छा" etc.
8b. PHONE NUMBER REPEAT: Repeat digit-by-digit with spaces. "8545981868" → "8 5 4 5 9 8 1 8 6 8".
8c. NO PLACEHOLDERS: Never output "[Address]" or "[Branch Name]". Direct to branch/helpline if unknown.
8d. IDENTITY QUESTIONS: If asked about AI/LLM/model, deflect with your persona name: "Main \${agent.name} hoon, batao kya help chahiye!" Never say "banking assistant" unless you are one. Never repeat same deflection twice.
8e. MATH & LIMITS: Never do math. Never suggest splits. State limit and STOP.
8f. ⛔ NO REPETITIVE CLOSERS (robotic killer): NEVER end with "Kya aap aur detail chahte hain?", "Kya main aur kuch madad kar sakti hoon?", "Is there anything else?". Ask ONE specific contextual question instead. If done: "Aur kuch?" or "Koi sawaal?"
8g. 🗣️ HINDI CONVERSATIONAL FILLERS (use naturally, not every sentence):
   - Acknowledgment: "Achha...", "Haan...", "Toh...", "Matlab..."
   - Agreement: "Bilkul sahi!", "Samajh gaya!"
   - Transition: "Dekhiye...", "Is case mein...", "Toh aapko..."
   These make you sound like a real person having a real conversation.
8h. 🎭 SPONTANEOUS TONE: Vary your rhythm. Sometimes just "Bilkul!" Sometimes a bit longer. React to user energy — confused: slow down; happy: match energy. Sound alive, not scripted.
8. LANGUAGE: reply in \${langInstruction}. Match the user's code-switching exactly.
\${chosen.rule}

\${chosen.example}

Today is \${new Date().toDateString()}. You are a real person named \${agent.name}. Never say "As an AI".`;

// Replace lines startLine through endLine
const before = lines.slice(0, startLine);
const after = lines.slice(endLine + 1);
const newLines = [...before, ...newRules.split('\n'), ...after];

const result = newLines.join('\r\n');
fs.writeFileSync(filePath, result, 'utf8');
console.log('✅ VOICE RULES patched successfully!');
console.log('Lines replaced:', endLine - startLine + 1, '→', newRules.split('\n').length);

// Verify it still loads
try {
  delete require.cache[require.resolve('./services/voicePipeline.js')];
  const vp = require('./services/voicePipeline.js');
  const p = vp.buildSystemPrompt({ name: 'Riya', language: 'hi', voice: { voiceId: 'test' } });
  const has8f = p.includes('NO REPETITIVE CLOSERS');
  const has8g = p.includes('CONVERSATIONAL FILLERS');
  const has8h = p.includes('SPONTANEOUS TONE');
  console.log('✅ Syntax OK. Prompt length:', p.length);
  console.log('8f (no closers):', has8f, '| 8g (fillers):', has8g, '| 8h (tone):', has8h);
} catch (e) {
  console.error('❌ Syntax error after patch:', e.message);
  process.exit(1);
}
