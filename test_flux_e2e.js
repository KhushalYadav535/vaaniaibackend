const fs = require('fs');
const WebSocket = require('ws');
const https = require('https');

const DEEPGRAM_API_KEY = '5210152b43cbcdec11b8325321fff95c007b08c9';
const TTS_URL = 'https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=16000';
const STT_URL = 'wss://api.deepgram.com/v2/listen?model=flux-general-multi&language_hint=en&language_hint=hi&encoding=linear16&sample_rate=16000';

console.log("Generating audio for 'what is jagriti yatra'...");
const req = https.request(TTS_URL, {
  method: 'POST',
  headers: {
    'Authorization': `Token ${DEEPGRAM_API_KEY}`,
    'Content-Type': 'application/json',
  }
}, (res) => {
  const audioChunks = [];
  res.on('data', chunk => audioChunks.push(chunk));
  res.on('end', () => {
    const audioBuffer = Buffer.concat(audioChunks);
    console.log("Audio generated, size:", audioBuffer.length);
    console.log("Connecting to Flux STT...");
    
    const ws = new WebSocket(STT_URL, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
    
    ws.on('open', () => {
      console.log('STT Connected');
      let offset = 0;
      const chunkSize = 3200; // 100ms
      const interval = setInterval(() => {
        if (offset >= audioBuffer.length) {
          clearInterval(interval);
          ws.send(JSON.stringify({ type: "CloseStream" }));
          return;
        }
        ws.send(audioBuffer.slice(offset, offset + chunkSize));
        offset += chunkSize;
      }, 100);
    });
    
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'TurnInfo' && msg.transcript) {
        console.log(`[Flux Transcript] "${msg.transcript}" (Final: ${msg.event !== 'Update'})`);
      } else if (msg.type === 'TurnCompleted' || msg.type === 'EndOfTurn') {
        console.log(`[Flux] Event:`, msg.type);
      }
    });
    
    ws.on('close', () => console.log('STT Connection Closed'));
  });
});

req.write(JSON.stringify({ text: "what is jagriti yatra" }));
req.end();
