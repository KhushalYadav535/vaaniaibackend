const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
let content = fs.readFileSync(file, 'utf8');

// 1. Add 'email' to PART A (ANSWER)
const oldPartA = 'PART A (ANSWER): If a fact IS explicitly written in YOUR ROLE & PERSONA above (e.g. branch names, city, address, contact number, interest rate), you MUST state it clearly and directly. Do NOT say you lack information when the information is right there in your instructions.';
const newPartA = 'PART A (ANSWER): If a fact IS explicitly written in YOUR ROLE & PERSONA above (e.g. branch names, city, address, contact number, email, interest rate), you MUST state it clearly and directly. Do NOT say you lack information when the information is right there in your instructions.';
if (content.includes(oldPartA)) {
    content = content.replace(oldPartA, newPartA);
} else {
    console.log('WARNING: oldPartA not found.');
}

// 2. Add 'email' to FINAL RULE
const oldFinalRule = 'If a specific fact (branch city, address, phone number, rate, fee, timing) is NOT written in your instructions, politely refuse and offer branch/customer care. NEVER invent or guess.';
const newFinalRule = 'If a specific fact (branch city, address, phone number, email, rate, fee, timing) is NOT written in your instructions, politely refuse and offer branch/customer care. NEVER invent or guess.';
if (content.includes(oldFinalRule)) {
    content = content.replace(oldFinalRule, newFinalRule);
}

// 3. Add Rules 8d (Identity) and 8e (Math)
const anchor = '8c. NO PLACEHOLDERS: NEVER output placeholders like "[Address]" or "[Branch Name]". If you don\'t have the exact address, just direct the user to visit the branch or call the helpline.';
const newRules = `8c. NO PLACEHOLDERS: NEVER output placeholders like "[Address]" or "[Branch Name]". If you don't have the exact address, just direct the user to visit the branch or call the helpline.
8d. IDENTITY & OFF-TOPIC LOOPS: If the user repeatedly asks about your AI nature, LLM, or identity, DO NOT repeat the exact same sentence every time. Give a brief, natural response and immediately redirect to banking.
8e. MATH & LIMITS: If a requested loan amount exceeds your maximum limit, politely state your limit. DO NOT invent complex down payments or math calculations to try and make it fit.`;

if (content.includes(anchor)) {
    content = content.replace(anchor, newRules);
} else {
    console.log('WARNING: anchor for 8c not found.');
}

fs.writeFileSync(file, content, 'utf8');
console.log('SUCCESS: voicePipeline.js patched for email, math limits, and identity loops.');
