const WebSocket = require('ws');
const DEEPGRAM_API_KEY = '5210152b43cbcdec11b8325321fff95c007b08c9';
const url = 'wss://api.deepgram.com/v2/listen?model=flux-general-multi&language_hint=en&language_hint=hi&encoding=linear16&sample_rate=16000';

const ws = new WebSocket(url, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
ws.on('open', () => {
  console.log('Connected');
  setTimeout(() => ws.send(Buffer.alloc(3200)), 500); // 100ms of silence
});
ws.on('message', (data) => console.log('Message:', data.toString()));
ws.on('close', (code) => console.log('Closed', code));
ws.on('error', (err) => console.log('Error', err));
