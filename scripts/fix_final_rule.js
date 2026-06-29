/**
 * Patch 2: Fix the FINAL RULE section in voicePipeline.js
 * The old rule only covered the "refuse" direction; add the "answer" direction.
 */
const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
let content = fs.readFileSync(file, 'utf8');

const OLD = 'prompt += `\\nFINAL RULE (highest priority): If a specific fact (branch or branch city, address, phone number, rate, fee, timing) is NOT written in your instructions, you do NOT know it — politely refuse and offer branch/customer care. NEVER invent or guess it, even at temperature 0, even if a guess would sound helpful.\\n`;';

const NEW = 'prompt += `\\nFINAL RULE (highest priority — two parts): (1) If a fact IS in your instructions, you MUST state it — do not say you lack info you actually have. (2) If a specific fact (branch city, address, phone number, rate, fee, timing) is NOT written in your instructions, politely refuse and offer branch/customer care. NEVER invent or guess.\\n`;';

if (!content.includes(OLD)) {
  console.error('ERROR: Could not find FINAL RULE target text.');
  process.exit(1);
}

content = content.replace(OLD, NEW);
fs.writeFileSync(file, content, 'utf8');
console.log('SUCCESS: FINAL RULE updated.');
