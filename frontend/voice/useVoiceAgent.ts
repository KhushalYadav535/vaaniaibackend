'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type VoiceStatus = 'idle' | 'requesting-mic' | 'connecting' | 'ready' | 'recording' | 'reconnecting' | 'error';

type ServerMessage = {
  type: string;
  sessionId?: string;
  firstMessage?: string;
  text?: string;
  data?: string;
  chunk?: string;
  message?: string;
  isFinal?: boolean;
};

type UseVoiceAgentOptions = {
  agentId: string;
  token: string;
  chunkMs?: number;
  autoReconnect?: boolean;
  debug?: boolean;
};

type UseVoiceAgentResult = {
  status: VoiceStatus;
  isConnected: boolean;
  isRecording: boolean;
  isAgentSpeaking: boolean;
  transcript: string;
  responseText: string;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
  interrupt: () => void;
};

const DEFAULT_CHUNK_MS = 250;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

function resolveVoiceWsUrl() {
  const explicitWs = process.env.NEXT_PUBLIC_WS_URL || process.env.NEXT_PUBLIC_VOICE_WS_URL;
  if (explicitWs) return explicitWs;

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl) {
    const url = new URL(apiUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws/voice';
    url.search = '';
    return url.toString();
  }

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.port = url.port === '3000' ? '5000' : url.port;
    url.pathname = '/ws/voice';
    return url.toString();
  }

  return 'ws://localhost:5000/ws/voice';
}

function selectRecorderMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

async function waitForSocketDrain(ws: WebSocket) {
  while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > MAX_BUFFERED_BYTES / 2) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export function useVoiceAgent({
  agentId,
  token,
  chunkMs = DEFAULT_CHUNK_MS,
  autoReconnect = true,
  debug = true,
}: UseVoiceAgentOptions): UseVoiceAgentResult {
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [responseText, setResponseText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const manualStopRef = useRef(false);
  const readyToStreamRef = useRef(false);
  const recorderMimeTypeRef = useRef('');
  const micSampleRateRef = useRef(48000);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const audioQueueRef = useRef<Blob[]>([]);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);
  const isPlayingRef = useRef(false);

  const log = useCallback(
    (...args: unknown[]) => {
      if (debug) console.debug('[VoiceAgent]', ...args);
    },
    [debug],
  );

  const clearPlayback = useCallback(() => {
    audioQueueRef.current = [];

    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current.src = '';
      currentAudioRef.current = null;
    }

    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current);
      currentAudioUrlRef.current = null;
    }

    isPlayingRef.current = false;
    setIsAgentSpeaking(false);
    log('playback cleared');
  }, [log]);

  const playNextAudio = useCallback(() => {
    if (isPlayingRef.current) return;

    const nextBlob = audioQueueRef.current.shift();
    if (!nextBlob) {
      setIsAgentSpeaking(false);
      return;
    }

    const url = URL.createObjectURL(nextBlob);
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    currentAudioUrlRef.current = url;
    isPlayingRef.current = true;
    setIsAgentSpeaking(true);

    const cleanup = () => {
      audio.pause();
      URL.revokeObjectURL(url);
      if (currentAudioRef.current === audio) currentAudioRef.current = null;
      if (currentAudioUrlRef.current === url) currentAudioUrlRef.current = null;
      isPlayingRef.current = false;
      playNextAudio();
    };

    audio.onended = cleanup;
    audio.onerror = cleanup;

    audio.play().then(
      () => log('response receive: playback started', { queued: audioQueueRef.current.length }),
      (playError) => {
        setError(`Audio playback blocked: ${playError.message}`);
        cleanup();
      },
    );
  }, [log]);

  const enqueueAudio = useCallback(
    (base64Audio: string) => {
      audioQueueRef.current.push(base64ToBlob(base64Audio, 'audio/mpeg'));
      log('response receive: audio chunk', { queued: audioQueueRef.current.length });
      playNextAudio();
    },
    [log, playNextAudio],
  );

  const sendJson = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const sendMicConfig = useCallback(() => {
    sendJson({
      type: 'mic_config',
      audioInputMode: 'webm',
      mimeType: recorderMimeTypeRef.current || 'audio/webm;codecs=opus',
      encoding: 'opus',
      sampleRate: 48000,
      browserSampleRate: micSampleRateRef.current,
      channels: 1,
    });
    log('mic_config sent', {
      audioInputMode: 'webm',
      mimeType: recorderMimeTypeRef.current,
      browserSampleRate: micSampleRateRef.current,
    });
  }, [log, sendJson]);

  const sendAudioBlob = useCallback(
    async (blob: Blob) => {
      const ws = wsRef.current;
      const recorder = recorderRef.current;

      if (!readyToStreamRef.current || !ws || ws.readyState !== WebSocket.OPEN || blob.size === 0) return;

      if (ws.bufferedAmount > MAX_BUFFERED_BYTES && recorder?.state === 'recording') {
        recorder.pause();
        log('recording paused for websocket backpressure', { bufferedAmount: ws.bufferedAmount });
        await waitForSocketDrain(ws);
        if (recorder.state === 'paused') recorder.resume();
      }

      const data = arrayBufferToBase64(await blob.arrayBuffer());
      ws.send(JSON.stringify({ type: 'audio', data }));
      log('chunk send', { bytes: blob.size, bufferedAmount: ws.bufferedAmount });
    },
    [log],
  );

  const startRecorder = useCallback(() => {
    if (!streamRef.current || recorderRef.current?.state === 'recording') return;

    const mimeType = recorderMimeTypeRef.current || selectRecorderMimeType();
    if (!mimeType) {
      throw new Error('This browser cannot record WebM/Opus audio. Use Chrome, Edge, or Firefox.');
    }

    recorderMimeTypeRef.current = mimeType;
    const recorder = new MediaRecorder(streamRef.current, {
      mimeType,
      audioBitsPerSecond: 32000,
    });

    recorder.onstart = () => {
      setIsRecording(true);
      setStatus('recording');
      log('recording start', { mimeType, chunkMs });
    };

    recorder.ondataavailable = (event) => {
      void sendAudioBlob(event.data);
    };

    recorder.onerror = (event) => {
      const recorderError = (event as Event & { error?: DOMException }).error?.message || 'MediaRecorder failed';
      setError(recorderError);
      setStatus('error');
    };

    recorder.onstop = () => {
      setIsRecording(false);
      log('recording stop');

      if (!manualStopRef.current && readyToStreamRef.current && streamRef.current?.active) {
        setTimeout(() => {
          try {
            startRecorder();
          } catch (restartError) {
            setError(restartError instanceof Error ? restartError.message : 'Recorder restart failed');
          }
        }, 250);
      }
    };

    recorderRef.current = recorder;
    recorder.start(chunkMs);
  }, [chunkMs, log, sendAudioBlob]);

  const ensureMic = useCallback(async () => {
    if (streamRef.current?.active) return;

    setStatus('requesting-mic');
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioContextCtor) {
        const audioContext = new AudioContextCtor();
        micSampleRateRef.current = audioContext.sampleRate;
        await audioContext.close();
      }

      recorderMimeTypeRef.current = selectRecorderMimeType();
      if (!recorderMimeTypeRef.current) {
        throw new Error('This browser cannot record WebM/Opus audio. Use Chrome, Edge, or Firefox.');
      }

      log('microphone ready', {
        browserSampleRate: micSampleRateRef.current,
        mimeType: recorderMimeTypeRef.current,
      });
    } catch (micError) {
      const message =
        micError instanceof DOMException && micError.name === 'NotAllowedError'
          ? 'Microphone permission was denied.'
          : micError instanceof Error
            ? micError.message
            : 'Could not start microphone.';

      setError(message);
      setStatus('error');
      throw new Error(message);
    }
  }, [log]);

  const connectSocket = useCallback(() => {
    const existing = wsRef.current;
    if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) return;

    readyToStreamRef.current = false;
    setStatus(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');

    const wsUrl = resolveVoiceWsUrl();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      setStatus('ready');
      reconnectAttemptRef.current = 0;

      ws.send(
        JSON.stringify({
          type: 'init',
          agentId,
          token,
          preferBinaryAudio: false,
          enableStt: true,
          streamProtocol: false,
        }),
      );

      log('websocket open + init sent', { wsUrl, agentId });

      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      pingTimerRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
    };

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.type === 'connected') {
        log('websocket connected', { sessionId: message.sessionId });
        return;
      }

      if (message.type === 'ready') {
        readyToStreamRef.current = true;
        sendMicConfig();
        startRecorder();
        log('ready received', { sessionId: message.sessionId, firstMessage: message.firstMessage });
        return;
      }

      if (message.type === 'transcript' && message.text) {
        setTranscript(message.text);
        log('transcript receive', { text: message.text, isFinal: message.isFinal });
        return;
      }

      if ((message.type === 'response_text' || message.type === 'response_text_chunk') && message.text) {
        setResponseText((previous) => (message.type === 'response_text_chunk' ? `${previous} ${message.text}`.trim() : message.text || previous));
        log('response receive: text', message.text);
        return;
      }

      if (message.type === 'audio' && message.data) {
        enqueueAudio(message.data);
        return;
      }

      if (message.type === 'audio_stream' && message.chunk) {
        enqueueAudio(message.chunk);
        return;
      }

      if (message.type === 'audio_end' || message.type === 'audio_stream_end') {
        log('response receive: audio_end');
        return;
      }

      if (message.type === 'interrupt' || message.type === 'clear_audio') {
        clearPlayback();
        return;
      }

      if (message.type === 'error') {
        setError(message.message || 'Voice server error');
        log('server error', message.message);
      }
    };

    ws.onerror = () => {
      setError('WebSocket connection failed.');
      setStatus('error');
    };

    ws.onclose = () => {
      setIsConnected(false);
      readyToStreamRef.current = false;
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);

      if (manualStopRef.current || !autoReconnect) return;

      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttemptRef.current, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttemptRef.current += 1;
      setStatus('reconnecting');
      log('websocket closed; reconnect scheduled', { delay });

      reconnectTimerRef.current = setTimeout(() => {
        connectSocket();
      }, delay);
    };
  }, [agentId, autoReconnect, clearPlayback, enqueueAudio, log, sendMicConfig, startRecorder, token]);

  const start = useCallback(async () => {
    manualStopRef.current = false;
    setTranscript('');
    setResponseText('');
    setError(null);
    await ensureMic();
    connectSocket();
  }, [connectSocket, ensureMic]);

  const interrupt = useCallback(() => {
    clearPlayback();
    sendJson({ type: 'interrupt' });
  }, [clearPlayback, sendJson]);

  const stop = useCallback(() => {
    manualStopRef.current = true;
    readyToStreamRef.current = false;

    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (pingTimerRef.current) clearInterval(pingTimerRef.current);

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    sendJson({ type: 'end_session' });
    wsRef.current?.close(1000, 'user stopped');
    wsRef.current = null;

    clearPlayback();
    setIsConnected(false);
    setIsRecording(false);
    setStatus('idle');
    log('session stopped');
  }, [clearPlayback, log, sendJson]);

  useEffect(() => stop, [stop]);

  return {
    status,
    isConnected,
    isRecording,
    isAgentSpeaking,
    transcript,
    responseText,
    error,
    start,
    stop,
    interrupt,
  };
}
