# Voice frontend drop-in

Add these variables to the Next.js app, then restart the dev server:

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_WS_URL=ws://localhost:5000/ws/voice
VOICE_WS_URL=ws://localhost:5000/ws/voice
```

Use `VoiceAgentPanel` from a client component after you have a valid `agentId` and JWT `token`.

The hook streams browser `MediaRecorder` WebM/Opus chunks every 250 ms as `{ type: "audio", data: base64 }`, which matches `websocket/voiceSession.js`.
