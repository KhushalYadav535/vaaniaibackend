/**
 * One-off: read the RAW stored voice config for agents (no Mongoose schema
 * coercion — we want the exact string saved by the frontend). Safe: read-only.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;

  // Raw native query so schema defaults/enums don't mask the real stored value.
  const agents = await db.collection('agents')
    .find({}, { projection: { name: 1, language: 1, voice: 1, llm: 1, status: 1 } })
    .toArray();

  console.log(`Total agents: ${agents.length}\n`);
  for (const a of agents) {
    console.log('────────────────────────────────────────');
    console.log('name        :', a.name);
    console.log('_id         :', String(a._id));
    console.log('status      :', a.status);
    console.log('language    :', a.language);
    console.log('llm.provider:', a.llm?.provider, '| model:', a.llm?.model);
    console.log('voice (raw) :', JSON.stringify(a.voice));
    if (a.voice) {
      console.log('  -> voice.provider:', JSON.stringify(a.voice.provider));
      console.log('  -> voice.voiceId :', JSON.stringify(a.voice.voiceId));
    }
  }
  console.log('────────────────────────────────────────');

  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });
