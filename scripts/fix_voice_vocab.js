/**
 * Patch: Fix two LLM output issues:
 * 1. "निम्नलिखित" (formal written Hindi) — ban literary/bureaucratic words
 * 2. Phone number echo — LLM should say digits separately when repeating numbers
 */
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
let content = fs.readFileSync(file, 'utf8');

// Target: The VOICE RULES block that's inside the template literal
// We'll find the "LANGUAGE: reply in" rule and add our rules just before it.
const ANCHOR = '8. LANGUAGE: reply in ${langInstruction}. Match the user\'s code-switching.';
const anchorIdx = content.indexOf(ANCHOR);
if (anchorIdx === -1) {
  console.error('ERROR: LANGUAGE anchor not found');
  process.exit(1);
}

// Insert new rules just BEFORE the LANGUAGE rule
const newRules = `8a. HINDI VOICE VOCABULARY: Use everyday conversational Hindi ONLY. FORBIDDEN words/phrases:
   - "निम्नलिखित" → use "ये" or just list naturally
   - "उपर्युक्त" → use "ऊपर बताए गए"
   - "कृपया ध्यान दें" at every turn → say it only when genuinely important
   - Starting every response with "ज़रूर!" — vary your acknowledgments: "हाँ जी", "बिल्कुल", "ठीक है", "अच्छा" etc.
8b. PHONE NUMBER REPEAT: When confirming a phone number or any number the user just said, ALWAYS repeat it digit-by-digit with spaces. E.g. user says "8545981868" → you say "8 5 4 5 9 8 1 8 6 8". NEVER say it as a single block like "8545981868".
`;

content = content.substring(0, anchorIdx) + newRules + content.substring(anchorIdx);
fs.writeFileSync(file, content, 'utf8');
console.log('SUCCESS: Voice vocabulary + phone echo rules injected.');
console.log('Verify anchor region:');
const verifyIdx = content.indexOf(newRules);
console.log(JSON.stringify(content.substring(verifyIdx - 10, verifyIdx + newRules.length + 30)));
