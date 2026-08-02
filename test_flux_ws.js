const WebSocket = require('ws');

const DEEPGRAM_API_KEY = '5210152b43cbcdec11b8325321fff95c007b08c9';
const url = 'wss://api.deepgram.com/v2/listen?model=flux-general-multi&language_hint=en&language_hint=hi&encoding=linear16&sample_rate=16000';

console.log('Connecting to', url);

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Token ${DEEPGRAM_API_KEY}`
  }
});

ws.on('open', () => {
  console.log('✅ Connected successfully to Deepgram Flux /v2/listen endpoint.');
  ws.close();
});

ws.on('message', (data) => {
  console.log('Received:', data.toString());
});

ws.on('close', () => {
  console.log('Connection closed.');
});

ws.on('error', (err) => {
  console.error('❌ WebSocket error:', err);
});
