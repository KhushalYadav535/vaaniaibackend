/**
 * One-off migration: regenerate embeddings for knowledge bases that were
 * processed before the schema stored `embedding` / `hasEmbeddings`.
 *
 * Before this fix, ragService.processDocument() generated embeddings but
 * Mongoose strict mode silently dropped them (the fields weren't in the
 * schema), so semantic search always fell back to keyword-only. This script
 * re-runs processing for any KB that is missing embeddings.
 *
 * Usage:  node scripts/reprocess-knowledge-bases.js
 */
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const KnowledgeBase = require('../models/KnowledgeBase');
const ragService = require('../services/ragService');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // KBs that have content but no embeddings yet (or were left in 'ready'
  // without the hasEmbeddings flag).
  const candidates = await KnowledgeBase.find({
    content: { $ne: '' },
    $or: [
      { hasEmbeddings: { $ne: true } },
      { hasEmbeddings: { $exists: false } },
    ],
  }).select('_id name');

  console.log(`Found ${candidates.length} knowledge base(s) to reprocess.`);

  let ok = 0;
  let failed = 0;
  for (const kb of candidates) {
    try {
      console.log(`→ Reprocessing "${kb.name}" (${kb._id})...`);
      await ragService.processDocument(kb._id);
      ok++;
    } catch (e) {
      console.error(`  ✗ Failed: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. Reprocessed: ${ok}, Failed: ${failed}.`);
  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
