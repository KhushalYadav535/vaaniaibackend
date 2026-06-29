/**
 * Patch: inject "couldn't hear" disambiguation rule at the exact position
 * found by the diagnostic run (anchor at 105449, closing backtick at 105557).
 */
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
let content = fs.readFileSync(file, 'utf8');

// Locate the closing sequence of the CONVERSATIONAL STYLE block.
// From diagnostic: "Do not sound robotic..." ends at 105555,
// then "\n`;\r\n" (5 chars) closes the template literal.
const ANCHOR = 'Do not sound robotic or use overly formal AI-like phrases (e.g. "I am an AI", "As an AI language model").';
const anchorIdx = content.indexOf(ANCHOR);
if (anchorIdx === -1) { console.error('ERROR: anchor not found'); process.exit(1); }

// Find the closing `; right after the anchor line
const closeSeq = '\n`;';
const closeIdx = content.indexOf(closeSeq, anchorIdx);
if (closeIdx === -1) { console.error('ERROR: closing backtick not found'); process.exit(1); }

// Inject new rule between the anchor line and the closing backtick
const insertPos = closeIdx; // insert just before \n`;
const newRule = `\n- ⛔ CRITICAL — "COULDN'T HEAR" RULE: NEVER say "माफ़ कीजिए, मैं आपकी बात स्पष्ट रूप से नहीं सुन पाई" (or any similar phrase) unless the user's message is EMPTY or pure gibberish. If ANY recognizable Hindi or English words are present — even a short or incomplete sentence — the voice was captured. Do NOT blame audio quality. Instead ask ONE short clarifying question, e.g. "आपकी मासिक आय कितनी है?" or "क्षमा करें, क्या आप थोड़ा और बता सकते हैं?"`;

const newContent = content.substring(0, insertPos) + newRule + content.substring(insertPos);
fs.writeFileSync(file, newContent, 'utf8');
console.log('SUCCESS: Clarity rule injected at position', insertPos);
console.log('Verify: characters around injection:');
console.log(JSON.stringify(newContent.substring(insertPos - 20, insertPos + newRule.length + 20)));
