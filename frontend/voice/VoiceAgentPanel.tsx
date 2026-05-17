'use client';

import { useVoiceAgent } from './useVoiceAgent';

type VoiceAgentPanelProps = {
  agentId: string;
  token: string;
};

export function VoiceAgentPanel({ agentId, token }: VoiceAgentPanelProps) {
  const voice = useVoiceAgent({
    agentId,
    token,
    chunkMs: 250,
    autoReconnect: true,
    debug: true,
  });

  const inCall = voice.status !== 'idle' && voice.status !== 'error';

  return (
    <section style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" onClick={voice.start} disabled={inCall}>
          Start voice
        </button>
        <button type="button" onClick={voice.interrupt} disabled={!voice.isConnected}>
          Interrupt
        </button>
        <button type="button" onClick={voice.stop} disabled={!inCall && !voice.isConnected}>
          End
        </button>
      </div>

      <div>Status: {voice.status}</div>
      <div>Mic: {voice.isRecording ? 'streaming' : 'off'}</div>
      <div>Agent audio: {voice.isAgentSpeaking ? 'playing' : 'idle'}</div>

      {voice.error ? <p style={{ color: '#b42318' }}>{voice.error}</p> : null}
      {voice.transcript ? <p>User: {voice.transcript}</p> : null}
      {voice.responseText ? <p>Agent: {voice.responseText}</p> : null}
    </section>
  );
}
