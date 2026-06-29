const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../services/ttsService.js');
let content = fs.readFileSync(file, 'utf8');

const OLD_CURRENCY_LOGIC = `    // 4b. Indian currency amounts with lakh/crore/hazar words
    result = result.replace(/(\\d+)\\s*लाख/gi, (m, n) => toHindiWord(n) + ' लाख');
    result = result.replace(/(\\d+)\\s*करोड़/gi, (m, n) => toHindiWord(n) + ' करोड़');
    result = result.replace(/(\\d+)\\s*हज़ार/gi, (m, n) => toHindiWord(n) + ' हज़ार');
    result = result.replace(/(\\d+)\\s*lakh/gi, (m, n) => toHindiWord(n) + ' लाख');
    result = result.replace(/(\\d+)\\s*crore/gi, (m, n) => toHindiWord(n) + ' करोड़');`;

const NEW_CURRENCY_LOGIC = `    // Helper for amounts with decimals
    const processDecimalWord = (n, word) => {
      if (n.includes('.')) {
        const [i, d] = n.split('.');
        return toHindiWord(i) + ' पॉइंट ' + toHindiWord(parseInt(d, 10)) + ' ' + word;
      }
      return toHindiWord(n) + ' ' + word;
    };

    // 4b. Indian currency amounts with lakh/crore/hazar words (supports decimals like 1.5 and optional ₹ prefix)
    result = result.replace(/(?:₹|Rs\\.?\\s*)?(\\d+(?:\\.\\d+)?)\\s*(लाख|lakh)s?/gi, (m, n) => processDecimalWord(n, 'लाख') + (m.includes('₹') || m.toLowerCase().includes('rs') ? ' रुपये' : ''));
    result = result.replace(/(?:₹|Rs\\.?\\s*)?(\\d+(?:\\.\\d+)?)\\s*(करोड़|crore)s?/gi, (m, n) => processDecimalWord(n, 'करोड़') + (m.includes('₹') || m.toLowerCase().includes('rs') ? ' रुपये' : ''));
    result = result.replace(/(?:₹|Rs\\.?\\s*)?(\\d+(?:\\.\\d+)?)\\s*(हज़ार|thousand)s?/gi, (m, n) => processDecimalWord(n, 'हज़ार') + (m.includes('₹') || m.toLowerCase().includes('rs') ? ' रुपये' : ''));
    
    // 4c. Simple ₹ with decimals (e.g., ₹1.5 -> एक पॉइंट पाँच रुपये)
    result = result.replace(/₹(\\d+\\.\\d+)/g, (m, n) => {
       const [i, d] = n.split('.');
       return toHindiWord(i) + ' पॉइंट ' + toHindiWord(parseInt(d, 10)) + ' रुपये';
    });`;

if (content.includes('4b. Indian currency amounts with lakh/crore/hazar words')) {
    // We need to replace the old block with the new block.
    // Let's use substring replacement to be safe.
    const startIdx = content.indexOf('// 4b. Indian currency amounts');
    const endIdx = content.indexOf('// 5. Year', startIdx);
    
    if (startIdx !== -1 && endIdx !== -1) {
        content = content.substring(0, startIdx) + NEW_CURRENCY_LOGIC + '\n\n    ' + content.substring(endIdx);
    } else {
        console.error("Could not find bounds for replacement.");
        process.exit(1);
    }
}

// Now let's fix the phone number zero pronunciation.
// In spaceDigits, replace '0' with ' ज़ीरो ' so it doesn't say 'shunya'.
const OLD_SPACE_DIGITS = `const spaceDigits = (s) => s.split('').join(' ');`;
const NEW_SPACE_DIGITS = `const spaceDigits = (s) => s.split('').map(d => d === '0' ? ' ज़ीरो ' : d).join(' ').replace(/\\s+/g, ' ');`;

if (content.includes(OLD_SPACE_DIGITS)) {
    content = content.replace(OLD_SPACE_DIGITS, NEW_SPACE_DIGITS);
}

fs.writeFileSync(file, content, 'utf8');
console.log('SUCCESS: TTS normalization for decimals and zeros updated.');
