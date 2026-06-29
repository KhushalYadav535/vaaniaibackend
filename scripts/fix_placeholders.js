const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/voicePipeline.js');
let content = fs.readFileSync(file, 'utf8');

const ANCHOR = '8a. HINDI VOICE VOCABULARY: Use everyday conversational Hindi ONLY. FORBIDDEN words/phrases:';
const NEW_RULE = `8c. NO PLACEHOLDERS: NEVER output placeholders like "[Address]" or "[Branch Name]". If you don't have the exact address, just direct the user to visit the branch or call the helpline.
`;

if (content.includes(ANCHOR)) {
    const nextRuleIdx = content.indexOf('8. LANGUAGE: reply in');
    if (nextRuleIdx !== -1) {
        content = content.substring(0, nextRuleIdx) + NEW_RULE + content.substring(nextRuleIdx);
        fs.writeFileSync(file, content, 'utf8');
        console.log('SUCCESS: NO PLACEHOLDERS rule injected.');
    } else {
        console.error('ERROR: Could not find 8. LANGUAGE anchor.');
    }
} else {
    console.error('ERROR: Could not find 8a anchor.');
}
