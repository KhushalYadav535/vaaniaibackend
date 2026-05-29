const vp = require('./services/voicePipeline');
const agent = { endCallPhrases: [] };

const shouldNotEnd = [
  'Basic इनको चाहिए बस.',          // the exact failing line
  'Basic inko chahiye bas',
  'basic website chahiye',
  'theek hai aage batao',
  'namaste, mujhe loan chahiye',
  'dhanyavaad, ab batao',
  'shukriya',
  'stop karke wait karo',          // "stop" mid-correction, not hangup
  'ok theek hai',
  'based pe decide karunga',
  'abas nagar se bol raha hoon',
];

const shouldEnd = [
  'bye',
  'goodbye',
  'alvida',
  'ok bye bye',
  'call band karo',
  'phone rakhta hoon',
  'acha main phone rakhti hoon',
  'baat khatam karo',
  'please hang up',
  'end the call now',
];

let pass = true;
console.log('=== should NOT end (mid-conversation) ===');
for (const t of shouldNotEnd) {
  const r = vp.shouldEndCall(t, agent);
  const ok = r === false;
  if (!ok) pass = false;
  console.log(`${ok ? 'OK ' : 'FAIL'}  end=${r}  "${t}"`);
}
console.log('\n=== should END (clear hangup) ===');
for (const t of shouldEnd) {
  const r = vp.shouldEndCall(t, agent);
  const ok = r === true;
  if (!ok) pass = false;
  console.log(`${ok ? 'OK ' : 'FAIL'}  end=${r}  "${t}"`);
}
console.log('\nRESULT:', pass ? 'ALL PASS ✅' : 'SOME FAILED ❌');
process.exit(pass ? 0 : 1);
