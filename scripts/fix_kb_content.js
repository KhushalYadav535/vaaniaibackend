/**
 * fix_kb_content.js
 * Cleans up PDF table-merge artifacts in the mnsbank KB content and triggers re-processing.
 */

const mongoose = require('mongoose');
require('dotenv').config();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const KB = require('../models/KnowledgeBase');
  const ragService = require('../services/ragService');

  const kb = await KB.findOne({ name: 'mnsbank' });
  if (!kb) { console.error('KB not found'); process.exit(1); }

  let content = kb.content;

  console.log('Original content length:', content.length);

  // ── 1. Remove repeated page header/footer ───────────────────────────
  content = content.replace(
    /Mahanagar Nagrik Sahakari Bank Ltd\.,?\s*Bhopal\s*NEHA AI[^]*?Page \d+\s*/g,
    '\n'
  );

  // ── 2. Fix table label+value merged without separator ────────────────
  // e.g. "TakeoverFrom other banks" → "Takeover: From other banks"
  // e.g. "Takeover ConditionCar age" → "Takeover Condition: Car age"
  const tableLabels = [
    'Takeover Condition',
    'Takeover',
    'Max\\. Loan Amount',
    'Min\\. Loan Amount',
    'Repayment Options',
    'On-Road Funding',
    'Credit History',
    'Pre-closure',
    'Income Proof',
    'Eligible',
    'Processing',
    'Security',
    'Tenure',
    'Margin',
    'LTV',
    'Purpose',
    'CIBIL Score',
    'Min\\. Salary \\(Salaried\\)',
    'Max\\. Deduction Limit',
    'Max\\. Tenure',
    'Salaried',
    'Businessmen',
    'Self-Employed',
    'Professionals',
    'Firm / LLP / Company',
    'Bank Name',
    'Location',
    'Branches',
    'Helpline',
    'Digital Banking',
    'Digital Services',
    'SMS Alerts',
    'Withdrawals',
    'Initial Deposit',
    'Min\\. Monthly Balance',
    'Min\\. Quarterly Avg Balance',
    'Non-Base Branch Withdrawal',
    'Cash Deposit \\(any branch\\)',
    'DD / PO',
    'Cheque Book',
    'Debit Card',
    'ATM — Own Bank',
    'ATM — Other Bank',
    'Ecom / POS / Withdrawal Limit',
    'Other',
    'Card Type',
    'Annual Maintenance',
    'Daily Transaction Limit',
    'ATM Cash Withdrawal',
    'Interest Rate',
    'Senior Citizen',
    'Exact Rates',
    'Interest Payout',
    'Types Available',
    'Ownership',
  ];

  // Sort by length descending so longer labels match before shorter prefixes
  tableLabels.sort((a, b) => b.length - a.length);

  tableLabels.forEach(label => {
    try {
      // Match label immediately followed by a capital letter / rupee / digit / Hindi char
      const re = new RegExp(`(${label})([A-Z₹\\d\u0900-\u097F])`, 'g');
      content = content.replace(re, '$1: $2');
    } catch (e) {
      // Skip invalid regex
    }
  });

  // ── 3. Fix ₹ sign glued to preceding text ───────────────────────────
  content = content.replace(/([a-zA-Z\u0900-\u097F)])(₹)/g, '$1\n$2');

  // ── 4. Remove comPage artifacts ─────────────────────────────────────
  content = content.replace(/comPage \d+/g, '');

  // ── 5. Normalize whitespace ─────────────────────────────────────────
  content = content.replace(/[ \t]{2,}/g, ' ');
  content = content.replace(/\n{3,}/g, '\n\n');

  console.log('Cleaned content length:', content.length);

  // Show the Car Loan section to verify
  const idx = content.indexOf('4.4 Car Loan');
  if (idx !== -1) {
    console.log('\n=== Car Loan section after cleanup ===');
    console.log(content.substring(idx, idx + 700));
  }

  // ── 6. Save cleaned content and reset for re-processing ─────────────
  kb.content = content;
  kb.status = 'processing';
  kb.chunks = [];
  kb.totalChunks = 0;
  kb.hasEmbeddings = false;
  kb.errorMessage = '';
  await kb.save();
  ragService._invalidateKBCache(kb._id);

  console.log('\nContent cleaned. Starting re-processing...');

  // ── 7. Re-process ────────────────────────────────────────────────────
  await ragService.processDocument(kb._id);
  console.log('Re-processing complete!');

  // Show a couple of chunks to verify
  const fresh = await KB.findById(kb._id, 'chunks totalChunks').lean();
  console.log('\nNew chunk count:', fresh.totalChunks);
  const carChunk = fresh.chunks.find(c => c.text.toLowerCase().includes('takeover'));
  if (carChunk) {
    console.log('\n=== Chunk containing "takeover" ===');
    console.log('Keywords:', (carChunk.keywords || []).join(', '));
    console.log('Summary:', carChunk.summary);
    console.log('Text:\n', carChunk.text);
  } else {
    console.log('\n⚠️ No chunk found with "takeover"');
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
