/**
 * One-shot patch: replaces the overly-aggressive KNOWLEDGE BOUNDARY block
 * in voicePipeline.js with a balanced two-sided rule that:
 *   - Requires the model to ANSWER facts that ARE in the system prompt
 *   - Requires the model to REFUSE facts that are NOT in the system prompt
 */
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
const content = fs.readFileSync(file, 'utf8');

// Markers — unique enough to locate the exact block
const BLOCK_HEADER = '## KNOWLEDGE BOUNDARY (STRICTLY ENFORCED — THIS OVERRIDES YOUR ROLE):';
const BLOCK_FOOTER = "and redirect.`;";  // the closing line (backtick+semicolon)

const blockStart = content.indexOf(BLOCK_HEADER);
if (blockStart === -1) {
  console.error('ERROR: Could not find KNOWLEDGE BOUNDARY header. Already patched?');
  process.exit(1);
}

// Find the closing "and redirect.`;" that belongs to THIS block (first occurrence after header)
const blockEnd = content.indexOf(BLOCK_FOOTER, blockStart);
if (blockEnd === -1) {
  console.error('ERROR: Could not find block footer.');
  process.exit(1);
}

const before = content.substring(0, blockStart);
const after  = content.substring(blockEnd + BLOCK_FOOTER.length);

const newBlock = `## KNOWLEDGE BOUNDARY (STRICTLY ENFORCED — THIS OVERRIDES YOUR ROLE):
- ⚠️ TWO-SIDED RULE — read BOTH parts carefully:
  PART A (ANSWER): If a fact IS explicitly written in YOUR ROLE & PERSONA above (e.g. branch names, city, address, contact number, interest rate), you MUST state it clearly and directly. Do NOT say you lack information when the information is right there in your instructions.
  PART B (REFUSE): If a fact is NOT written anywhere in your instructions above, you MUST refuse with: \${refusalLang}
- ⛔ HALLUCINATION FORBIDDEN: Do NOT invent or guess any fact (branch locations, addresses, phone numbers, rates, fees, timings) that is NOT written in your instructions above.
- ⛔ SILENCE IS ALSO WRONG: Refusing to share facts that ARE in your instructions is a failure — almost as bad as hallucinating.
- CORRECT EXAMPLE: User asks "branch kahan hai?" and your instructions say "Branches: TT Nagar & Karond, Bhopal" → you MUST answer "Hamare branches TT Nagar aur Karond, Bhopal mein hain."
- WRONG EXAMPLE: User asks "branch kahan hai?" → your instructions have the branch names → but you say "mujhe jaankari nahi hai." ← THIS IS WRONG. You DO have the info.
- NEVER assume you have the user's name, phone number, or details unless they explicitly state them.
- Stay on-topic. If asked something off-topic, politely say: "Main sirf \${agent.name || 'is service'} se related banking queries mein madad kar sakti hoon." and redirect.\`;`;

const newContent = before + newBlock + after;
fs.writeFileSync(file, newContent, 'utf8');
console.log('SUCCESS: KNOWLEDGE BOUNDARY guardrail updated.');
console.log('Lines changed: replaced single-sided refusal with two-sided answer/refuse rule.');
