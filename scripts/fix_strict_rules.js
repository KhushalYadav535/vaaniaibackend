const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
let content = fs.readFileSync(file, 'utf8');

const OLD_RULES = `8d. IDENTITY & OFF-TOPIC LOOPS: If the user repeatedly asks about your AI nature, LLM, or identity, DO NOT repeat the exact same sentence every time. Give a brief, natural response and immediately redirect to banking.
8e. MATH & LIMITS: If a requested loan amount exceeds your maximum limit, politely state your limit. DO NOT invent complex down payments or math calculations to try and make it fit.`;

const NEW_RULES = `8d. IDENTITY QUESTIONS (CRITICAL): If the user asks about your AI model, LLM, or technology (e.g. "which LLM?", "11 labs?"), give ONE SHORT natural response (e.g. "मैं सिर्फ एक बैंकिंग असिस्टेंट हूँ।") and move on. NEVER repeat the exact same sentence twice in a row. DO NOT get stuck in a loop.
8e. MATH & LOAN LIMITS (CRITICAL): NEVER do math for the user. NEVER suggest percentage splits (like "70% loan, 30% down payment"). If a user asks for an amount higher than your limit, just say your limit (e.g. "हमारा मैक्सिमम लोन 30 लाख है") and STOP. DO NOT offer complex mathematical alternatives.`;

if (content.includes(OLD_RULES)) {
    content = content.replace(OLD_RULES, NEW_RULES);
    fs.writeFileSync(file, content, 'utf8');
    console.log('SUCCESS: Stricter rules for Identity and Math injected.');
} else {
    console.error('ERROR: Could not find old rules.');
}
