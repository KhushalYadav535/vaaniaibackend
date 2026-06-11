/**
 * WebSocket Voice Session Handler
 * 
 * Handles real-time browser voice testing:
 * Browser Mic → WebSocket (PCM audio) → Deepgram STT → Groq LLM → Edge TTS → WebSocket (MP3) → Browser speaker
 * 
 * Protocol:
 * Client sends: { type: 'init', agentId, token } to start session
 * Client sends: { type: 'audio', data: base64AudioChunk } for audio data
 * Client sends: { type: 'end_audio' } when speaking stops (for batch STT)
 * Client sends: { type: 'text', text: '...' } for text input (testing without mic)
 * Client sends: { type: 'end_session' } to end call
 * 
 * Server sends: { type: 'ready', sessionId, firstMessage } when initialized
 * Server sends: { type: 'transcript', text, isFinal } as user speaks
 * Server sends: { type: 'response_text', text } when AI response ready
 * Server sends: { type: 'audio', data: base64AudioChunk } for TTS audio
 * Server sends: { type: 'audio_end' } when audio chunk done
 * Server sends: { type: 'status', message } for status updates
 * Server sends: { type: 'error', message } for errors
 * Server sends: { type: 'session_ended', summary } when call ends
 */

const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const Agent = require('../models/Agent');
const User = require('../models/User');
const CallLog = require('../models/CallLog');
const voicePipeline = require('../services/voicePipeline');
const deepgramService = require('../services/deepgramService');
const notificationService = require('../services/notificationService');
const ragService = require('../services/ragService');
const CallFlow = require('../models/CallFlow');
const callFlowEngine = require('../services/callFlowEngine');
const webhookDispatcher = require('../services/webhookDispatcher');
const ttsService = require('../services/ttsService');
const serverEvents = require('../services/serverEventsDispatcher');

// Track active sessions
const activeSessions = new Map();

// Concurrency cap — protects free-tier API quotas (Groq, Deepgram) and server CPU.
// When the cap is hit, new connections are rejected with a 1013 (try again later)
// close code so the client can show a polite "system busy" message.
const MAX_CONCURRENT_SESSIONS = Number(process.env.MAX_CONCURRENT_SESSIONS || process.env.MAX_CONCURRENT_CALLS || 25);

// Hard idle timeout — kills sessions that have stopped sending any audio
// or messages for this long. Prevents zombie sessions from accumulating
// when a browser tab is closed without a clean WS close.
const SESSION_HARD_IDLE_MS = Number(process.env.SESSION_HARD_IDLE_MS || 5 * 60 * 1000);

function getActiveSessionCount() {
  return activeSessions.size;
}

function canAcceptNewSession() {
  return activeSessions.size < MAX_CONCURRENT_SESSIONS;
}

// Reaper: every 30s, kill sessions whose last activity exceeded the idle window.
// Aborts in-flight LLM HTTP requests and flushes any pending call-log writes
// before closing — without these the reaper would leak Groq/Gemini quota and
// silently lose the last few transcript turns.
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of activeSessions.entries()) {
    const last = sess._lastActivityAt || sess.startTime || now;
    if (now - last > SESSION_HARD_IDLE_MS) {
      console.log(`[Reaper] Killing idle session ${id} (idle ${Math.round((now - last) / 1000)}s)`);
      // 1. Abort any in-flight LLM call so it stops burning quota
      if (sess._currentAbortController) {
        try { sess._currentAbortController.abort(); } catch (_) {}
        sess._currentAbortController = null;
      }
      // 2. Clear pending timers so they can't fire on a dead session
      if (sess._idleTimer)         { clearTimeout(sess._idleTimer);         sess._idleTimer = null; }
      if (sess._silenceTimer)      { clearTimeout(sess._silenceTimer);      sess._silenceTimer = null; }
      if (sess._agentSpeakingTimer){ clearTimeout(sess._agentSpeakingTimer);sess._agentSpeakingTimer = null; }
      if (sess._dtmfFlushTimer)    { clearTimeout(sess._dtmfFlushTimer);    sess._dtmfFlushTimer = null; }
      if (sess._softCommitTimer)   { clearTimeout(sess._softCommitTimer);   sess._softCommitTimer = null; }
      if (sess._logFlushInterval)  { clearInterval(sess._logFlushInterval); sess._logFlushInterval = null; }
      sess._softCommitBuffer = '';
      // 3. Flush any pending transcript writes so we don't lose turns
      flushCallLogWriteQueue(sess).catch(() => {});
      // 4. Close Deepgram + WS politely
      try { sess.deepgramConn?.finish(); } catch (_) {}
      try {
        if (sess.ws && sess.ws.readyState === 1) sess.ws.close(1000, 'idle_timeout');
      } catch (_) {}
      activeSessions.delete(id);
    }
  }
}, 30000).unref?.();

function touchSession(session) {
  session._lastActivityAt = Date.now();
}

/**
 * Soft-commit window for utterances.
 *
 * Why this exists: Deepgram fires `speech_final` after ~400ms of silence,
 * which is great for snappy turns but BAD when the user is thinking mid-
 * thought. A real conversation looks like:
 *   "मुझे school के लिए एक website..."  [pause 700ms — thinking]
 *   "...इसमें..."                        [pause 600ms — recalling name]
 *   "...है MDS Vidyapeeth aur city Prayagraj"
 *
 * Without soft-commit, the agent fires THREE replies — talking over each
 * fragment. With soft-commit, we hold the speech_final for ~800ms; if the
 * user resumes, we append and reset the timer. The agent only replies
 * after the user has TRULY finished.
 *
 * Modes:
 *   - speech_final → append to buffer, reset timer
 *   - interim transcript with content → reset timer (user is still talking)
 *   - timer fires → flush buffer through processTranscript
 *   - interrupt (agent was speaking) → immediate fire, bypass soft-commit
 */
/**
 * Decide how long to hold a finalized utterance before committing it.
 *
 * This is the core of human-like turn-taking (what Vapi/Retell tune
 * heavily). A flat 800ms window cuts users off when they pause mid-number
 * ("nau double zero... [pause] ...five seven five...") or mid-thought.
 *
 * We EXTEND the window when the buffer looks incomplete:
 *   - ends in a digit  → user is likely reading a phone/account number
 *   - ends in a connector (aur / और / lekin / and / comma) → more coming
 *   - very short so far → give them a beat to continue
 * Otherwise we use the snappy default so normal turns stay fast.
 */
function getSoftCommitWindowMs(text) {
  const base       = Number(process.env.UTTERANCE_SOFT_COMMIT_MS || 800);
  const numericMs  = Number(process.env.UTTERANCE_SOFT_COMMIT_NUMERIC_MS || 2400);
  const connectorMs= Number(process.env.UTTERANCE_SOFT_COMMIT_CONNECTOR_MS || 1500);
  const completeMs = Number(process.env.UTTERANCE_SOFT_COMMIT_COMPLETE_MS || 450);
  const t = String(text || '').trim();
  if (!t) return base;

  const lower = t.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const lastWord = words[words.length - 1] || '';

  // ── 1. Mid-number (highest priority) ────────────────────────────────────
  // An incomplete digit run (1-9 digits) means a phone/account/OTP is still
  // being dictated. Wait long — getting cut off mid-number is the worst.
  const lastNumberRun = (t.match(/([\d][\d\s,.:/-]*)$/) || [''])[0].replace(/\D/g, '');
  if (lastNumberRun.length > 0 && lastNumberRun.length < 10) {
    return numericMs;
  }

  // ── 2. Hesitation / filler endings → user is THINKING, not done ─────────
  // Retell calls this "filler-word panic" — jumping in on "um/uh/matlab".
  // These almost always precede more speech, so wait longer.
  const hesitationRe = /(um|uh|umm|uhh|hmm|er|aa+|matlab|maltab|yaani|woh|वो|मतलब|ã|एं| um+)$/i;
  if (hesitationRe.test(lastWord)) return connectorMs;

  // ── 3. Connector / clause-continuation endings → more coming ────────────
  // Check the trailing word(s). Hindi postpositions (ke/ki/ka/liye/ko/se/me)
  // and conjunctions almost always have more speech after them.
  const connectorWords = new Set([
    'aur','और','lekin','लेकिन','ki','कि','ke','का','ka','ko','को','se','से',
    'me','mein','में','liye','लिए','kyunki','क्योंकि','matlab','मतलब','phir',
    'फिर','toh','तो','ya','या','and','but','so','because','jaise','जैसे',
    'that','with','for','to','ek','एक','par','पर','wala','wali','vala',
  ]);
  // last two words joined too (catches "ke liye", "ki taraf")
  const lastTwo = words.slice(-2).join(' ');
  if (connectorWords.has(lastWord) || /[,;:-]$/.test(t)
      || lastTwo.endsWith('ke liye') || lastTwo.endsWith('के लिए')) {
    return connectorMs;
  }

  // ── 4. Very short utterance with no terminal punctuation ────────────────
  // 1-2 words and no '?'/'.' — likely the START of a longer thought
  // ("Mujhe...", "Haan woh..."). Give a beat. But a clear short answer
  // ("haan", "nahi", "theek hai") should still be snappy → handled in 5/6.
  const shortAcks = ['haan','haa','nahi','nahin','ok','okay','theek','yes','no','sahi','bilkul','done'];
  const isShortAck = words.length <= 2 && shortAcks.some(a => lower === a || lower.startsWith(a + ' ') || lower === a + '.');

  // ── 5. Semantic completion → respond FAST ───────────────────────────────
  // Ends in terminal punctuation (?/।/.) OR is a clear short ack → the turn
  // looks complete, so use the snappy window for a responsive feel.
  const endsComplete = /[.?!।]$/.test(t);
  if (endsComplete || isShortAck) return completeMs;

  // ── 6. Short, unpunctuated, non-ack → probably mid-thought ──────────────
  if (words.length <= 2) return connectorMs;

  // Default: normal complete-feeling statement.
  return base;
}

/**
 * Merge a freshly finalized transcript fragment into the soft-commit buffer.
 *
 * Deepgram frequently re-fires speech_final for the SAME utterance with a
 * corrected/extended transcript (e.g. "...number hai 9005754" then
 * "...number hai 9005754137"). Blindly appending produced two bugs we saw
 * in production:
 *   1. Garbled numbers — "9005754 9005754137" → LLM thinks user gave two
 *      different numbers and asks them to confirm.
 *   2. Triple-repeated lines — the whole sentence re-fired and got appended
 *      again as a "new" turn.
 *
 * Strategy: detect prefix/extension/subset relationships and REPLACE rather
 * than concatenate. Only genuinely new content gets appended.
 */
function mergeUtterance(buffer, text) {
  const a = String(buffer || '').trim();
  const b = String(text || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;

  const an = a.toLowerCase();
  const bn = b.toLowerCase();

  // New text is an extension of what we have → take the fuller version.
  if (bn.startsWith(an)) return b;
  // New text is a subset/prefix of what we have → keep the fuller version.
  if (an.startsWith(bn)) return a;
  // Exact trailing duplicate.
  if (an.endsWith(bn)) return a;

  // Heuristic for re-dictated content: if both end in a digit run and one
  // run is an extension of the other, replace the tail with the longer run.
  // The separator class includes : . / because STT (smart_format) sometimes
  // formats a spoken phone number as a time/date ("09:05 754137"); we strip
  // those separators so the full digit run is compared, not just the tail.
  const digitRunRe = /([\d][\d\s,.:/-]*)$/;
  const aDigits = (a.match(digitRunRe) || [''])[0].replace(/\D/g, '');
  const bDigits = (b.match(digitRunRe) || [''])[0].replace(/\D/g, '');
  if (aDigits && bDigits && (bDigits.startsWith(aDigits) || aDigits.startsWith(bDigits))) {
    // Same number being dictated — prefer the longer digit run, rebuilt on
    // top of whichever sentence carried it.
    return bDigits.length >= aDigits.length ? b : a;
  }

  // Genuinely new content — append.
  return `${a} ${b}`.replace(/\s+/g, ' ').trim();
}

function commitTranscript(session, transcript, { immediate = false } = {}) {
  const text = (transcript || '').trim();
  if (!text || text.length < 2) return;

  // Smart-merge so re-fired / extended transcripts (especially numbers)
  // don't duplicate or garble the buffer.
  session._softCommitBuffer = mergeUtterance(session._softCommitBuffer, text);

  // Bypass for interrupt path — fire immediately so the agent doesn't keep
  // talking over a user who's clearly trying to interrupt.
  if (immediate) {
    flushSoftCommit(session);
    return;
  }

  const windowMs = getSoftCommitWindowMs(session._softCommitBuffer);
  if (session._softCommitTimer) clearTimeout(session._softCommitTimer);
  session._softCommitTimer = setTimeout(() => {
    flushSoftCommit(session);
  }, windowMs);
}

/**
 * Reset the soft-commit timer without changing the buffer. Called when
 * the user is mid-utterance (interim transcript arrives with content) so
 * the commit doesn't fire while they're still talking. Uses the same
 * dynamic window so a mid-number pause doesn't trigger a premature commit.
 */
function bumpSoftCommitTimer(session) {
  if (!session._softCommitBuffer || !session._softCommitTimer) return;
  const windowMs = getSoftCommitWindowMs(session._softCommitBuffer);
  clearTimeout(session._softCommitTimer);
  session._softCommitTimer = setTimeout(() => {
    flushSoftCommit(session);
  }, windowMs);
}

/**
 * Flush the accumulated transcript into the pipeline.
 */
function flushSoftCommit(session) {
  if (session._softCommitTimer) { clearTimeout(session._softCommitTimer); session._softCommitTimer = null; }
  const merged = (session._softCommitBuffer || '').trim();
  session._softCommitBuffer = '';
  if (!merged || merged.length < 2) return;
  if (session.isProcessing) return;
  if (session.status === 'ended') return;

  // Reset per-turn STT scratch state. processTranscript now owns the
  // isProcessing guard + latency timers (set atomically there) so we no
  // longer pre-set them here — doing so was part of the double-fire race.
  session._userSpeechStartTime = null;
  session._backchannelTriggered = false;
  session._lastSttTranscript = '';
  console.log(`[STT] soft-commit flush → "${merged}"`);
  processTranscript(session, merged).catch(e => {
    console.error('Error processing soft-commit transcript:', e);
  });
}

/**
 * Build the FULL Deepgram onTranscript handler for a session.
 *
 * Why this exists: previously handleMicConfig and trySttFallbackReconnect
 * created Deepgram connections with a dumbed-down handler that lacked
 * interruption detection, backchanneling, idle timers and silence-timer
 * fallback. The user got a silently degraded experience after mic_config.
 * One handler factory keeps them in sync forever.
 */
function buildSessionOnTranscript(session) {
  return async ({ transcript, isFinal, speechFinal }) => {
    const agent = session.agent;
    if (!agent) return;

    // ── Interruption detection: user speaks while agent is talking ──
    if (session.agentSpeaking) {
      const sensitivity = agent.advanced?.interruptionSensitivity ?? 0.5;
      const charThreshold = Math.max(5, Math.round(20 * (1 - sensitivity)));

      const trimmedText = transcript.trim().toLowerCase();
      const wordCount = trimmedText.split(/\s+/).length;

      const noiseWords = ['hmm', 'um', 'uh', 'ah', 'oh', 'yeah', 'yes', 'ok', 'okay', 'haan', 'acha', 'accha', 'hmm...', 'right'];
      const isJustNoise = wordCount <= 2 && noiseWords.some(w => trimmedText === w || trimmedText.startsWith(w));

      const stopWords = ['stop', 'wait', 'hold on', 'ruko', 'ek second', 'listen', 'no', 'nahi', 'galat'];
      const hasStopWord = stopWords.some(w => trimmedText.includes(w));

      const shouldInterrupt = hasStopWord || (!isJustNoise && (trimmedText.length >= charThreshold || wordCount >= 3));

      // ── Debounce: after firing one interrupt, suppress further filler+
      // interrupt churn for a short window. The filler TTS itself sets
      // agentSpeaking=true briefly which would otherwise re-trigger this
      // branch on every new interim transcript and cause a "Haan boliye /
      // Sorry, go ahead." loop. Default 1200ms — Vapi/Retell tune this between
      // 800-1500ms; 2500ms felt sluggish on rapid-fire interrupts.
      const INTERRUPT_DEBOUNCE_MS = Number(process.env.INTERRUPT_DEBOUNCE_MS || 1200);
      const recentlyInterrupted = session._interruptFiredAt && (Date.now() - session._interruptFiredAt < INTERRUPT_DEBOUNCE_MS);

      if (shouldInterrupt && !recentlyInterrupted) {
        console.log(`[Interrupt] User spoke during agent TTS: "${transcript.trim().substring(0, 60)}"`);
        session._interruptFiredAt = Date.now();

        session.currentGenerationId = uuidv4();
        // Abort the in-flight LLM HTTP request so it actually stops
        // consuming a Groq SDK connection slot. Without this, parallel
        // interrupts queue up behind dead streams and the next real
        // request hits a "groq_completion_timeout".
        if (session._currentAbortController) {
          try { session._currentAbortController.abort(); } catch (_) {}
          session._currentAbortController = null;
        }
        session.agentSpeaking = false;
        session._audioQueueDurationMs = 0;
        if (session._agentSpeakingTimer) { clearTimeout(session._agentSpeakingTimer); session._agentSpeakingTimer = null; }
        session.isProcessing = false;

        safeSend(session.ws, { type: 'interrupt' });
        safeSend(session.ws, { type: 'clear_audio' });

        // Interrupt filler ("Haan boliye / Sorry, go ahead") is OPT-IN.
        // The polished default is: stop the agent, listen quietly, then
        // respond to what the user actually said. Talking over an
        // interrupting user with a filler is what makes voice agents feel
        // robotic — Vapi/Retell ship with no filler by default.
        // Enable explicitly via INTERRUPT_FILLER_ENABLED=true.
        const fillerEnabled = String(process.env.INTERRUPT_FILLER_ENABLED || 'false').toLowerCase() === 'true';
        if (fillerEnabled) {
          const lang = agent.language || 'en';
          const interruptFillers = {
            'en': 'Sorry, go ahead.',
            'hi': 'Haan boliye.',
            'hi-Latn': 'Haan boliye.',
            'multi': 'Haan boliye.',
            'en-IN': 'Sorry, go ahead.'
          };
          const fillerText = interruptFillers[lang] || interruptFillers['en'];
          ttsService.textToSpeech({
            text: fillerText,
            voiceId: agent.voice?.voiceId,
            speed: 1.15,
            provider: agent.voice?.provider
          }).then(audioBuffer => {
            if (audioBuffer && audioBuffer.length > 0) {
              safeSend(session.ws, { type: 'response_text', text: fillerText });
              sendAudioBuffer(session, audioBuffer);
            }
          }).catch(e => console.error('Interruption TTS failed:', e));
        }

        session._lastSttTranscript = transcript;

        // Route interrupt utterances through the same soft-commit window
        // so a user who interrupts mid-thought ("ruko... actually...") gets
        // ONE merged turn instead of two fragments.
        if (isFinal && speechFinal && transcript.trim().length > 0) {
          if (session._silenceTimer) { clearTimeout(session._silenceTimer); session._silenceTimer = null; }
          console.log(`[STT] Interrupt speech_final buffered: "${transcript}"`);
          commitTranscript(session, transcript);
          return;
        }

        if (session._softCommitBuffer && session._softCommitTimer) {
          bumpSoftCommitTimer(session);
          return;
        }

        if (session._silenceTimer) clearTimeout(session._silenceTimer);
        // Shorter fallback (700ms) on the interrupt path so a quiet
        // interrupt ("ruko") that never gets a speech_final still flushes
        // promptly. Soft-commit still wraps the actual processTranscript.
        session._silenceTimer = setTimeout(() => {
          session._silenceTimer = null;
          const pending = session._lastSttTranscript;
          if (!pending || pending.trim().length < 2) return;
          if (session.isProcessing) return;
          if (session._softCommitBuffer && session._softCommitTimer) {
            bumpSoftCommitTimer(session);
            return;
          }

          const allowInterimFallback = String(process.env.STT_ALLOW_INTERIM_FALLBACK_COMMIT || 'false').toLowerCase() === 'true';
          if (!allowInterimFallback) {
            console.log('[STT] Interrupt silence fallback saw interim text but no speech_final; not committing interim transcript');
            return;
          }

          console.warn(`[STT] Interrupt interim fallback commit enabled; buffering: "${pending}"`);
          commitTranscript(session, pending);
        }, 700);
      }
      return;
    }

    // Normal listening path: forward interim transcripts + run timers
    // Reset the interrupt-debounce window once the user has actually
    // produced a final transcript — at that point the previous interrupt
    // is fully consumed and a new one is legitimate.
    if (isFinal && speechFinal) {
      session._interruptFiredAt = 0;
    }

    safeSend(session.ws, {
      type: 'transcript',
      text: transcript,
      isFinal: false,
      role: 'user',
    });

    if (transcript.trim().length > 0) {
      if (session._idleTimer) { clearTimeout(session._idleTimer); session._idleTimer = null; }
      session._lastSttTranscript = transcript;

      // Active backchanneling — fires only when the user has been talking
      // for a while AND the latest interim transcript looks like a
      // complete-feeling clause (ended on a comma/and/aur/lekin/but).
      // Random fillers feel intrusive; mid-thought pauses feel attentive.
      // Also gated by a per-session cooldown so we don't double-fire on
      // long monologues.
      if (!session._userSpeechStartTime) {
        session._userSpeechStartTime = Date.now();
        session._backchannelTriggered = false;
      } else {
        const speechMs = Date.now() - session._userSpeechStartTime;
        const enoughSilenceSinceLast = !session._lastBackchannelAt
          || (Date.now() - session._lastBackchannelAt > 8000);
        const trimmed = transcript.trim();
        const looksLikeClauseEnd = /[,;:]$/.test(trimmed)
          || /\b(and|but|so|because|aur|lekin|kyunki|matlab|toh)$/i.test(trimmed);
        const shouldBackchannel =
          speechMs > 4500
          && !session._backchannelTriggered
          && !session.agentSpeaking
          && enoughSilenceSinceLast
          && looksLikeClauseEnd;

        if (shouldBackchannel) {
          session._backchannelTriggered = true;
          session._lastBackchannelAt = Date.now();
          console.log('[Backchannel] Mid-thought pause detected — injecting active listening filler...');
          const lang = agent.language || 'en';
          const backchannels = {
            'en':      ['Mhmm...', 'Right.', 'I see.'],
            'hi':      ['Mhmm...', 'Accha.', 'Haan...'],
            'hi-Latn': ['Mhmm...', 'Accha.', 'Haan...'],
            'multi':   ['Mhmm...', 'Accha.'],
            'en-IN':   ['Mhmm...', 'Right.'],
          };
          const options = backchannels[lang] || backchannels['en'];
          const backchannelText = options[Math.floor(Math.random() * options.length)];
          ttsService.textToSpeech({
            text: backchannelText,
            voiceId: agent.voice?.voiceId,
            speed: 0.9,
            provider: agent.voice?.provider,
          }).then(audioBuffer => {
            if (audioBuffer && audioBuffer.length > 0) sendAudioBuffer(session, audioBuffer);
          }).catch(e => console.error('Backchannel TTS failed:', e));
        }
      }
    }

    // Path 1: Deepgram speech_final
    // Soft-commit window: don't fire processTranscript yet — buffer this
    // utterance and let the soft-commit timer flush it after ~800ms of
    // true silence. If user keeps talking, the buffer accumulates and we
    // process ONE merged turn, not three fragments.
    if (isFinal && speechFinal && transcript.trim().length > 0) {
      if (session._silenceTimer) { clearTimeout(session._silenceTimer); session._silenceTimer = null; }
      if (session.isProcessing) return;
      console.log(`[STT] speech_final buffered: "${transcript}"`);
      commitTranscript(session, transcript);
      return;
    }

    // Path 2: Client-side silence-timer fallback. If we have a soft-commit
    // buffer in flight, just bump its timer — the user is still on the
    // same turn. Otherwise fall back to the legacy 900ms timer for the
    // case where Deepgram never fires speech_final.
    if (session._softCommitBuffer && session._softCommitTimer) {
      bumpSoftCommitTimer(session);
      return;
    }

    if (session._silenceTimer) clearTimeout(session._silenceTimer);
    const silenceFallbackMs = Number(process.env.STT_SILENCE_FALLBACK_MS || 900);
    session._silenceTimer = setTimeout(async () => {
      session._silenceTimer = null;
      if (session.agentSpeaking) return;
      if (session.isProcessing) return;
      if (session._softCommitBuffer && session._softCommitTimer) {
        bumpSoftCommitTimer(session);
        return;
      }

      const allowInterimFallback = String(process.env.STT_ALLOW_INTERIM_FALLBACK_COMMIT || 'false').toLowerCase() === 'true';
      if (!allowInterimFallback) {
        console.log('[STT] silence fallback saw interim text but no speech_final; not committing interim transcript');
        return;
      }

      const pending = session._lastSttTranscript;
      if (!pending || pending.trim().length < 2) return;
      console.warn(`[STT] Interim fallback commit enabled; buffering: "${pending}"`);
      commitTranscript(session, pending);
    }, silenceFallbackMs);
  };
}

/**
 * Build VAD event handler. Forwards speech_started events to the client
 * so it can prime its UI state when user begins talking over the agent.
 */
function buildSessionOnVADEvent(session) {
  return (event) => {
    if (event.type === 'speech_started' && session.agentSpeaking) {
      safeSend(session.ws, { type: 'vad_speech_started' });
    }
  };
}

/**
 * Tiny universal English-keyword seed.
 * These are domain-agnostic words that appear in nearly every business
 * conversation (any Indian user calling any agent will say one of these).
 * Domain-specific keywords are auto-extracted from agent context — see
 * extractAgentKeywords() below — instead of being hardcoded here.
 */
const UNIVERSAL_HINGLISH_SEED = [
  'website', 'app', 'call', 'email', 'phone', 'service', 'business',
];

/**
 * Pull English-looking domain keywords out of the agent's own configuration.
 * The agent's systemPrompt, firstMessage, and name already encode the
 * vocabulary that domain's users will say — boosting THESE adapts STT to
 * any industry (lawyer, salon, doctor, gym, school, ...) without us
 * predicting domains in advance.
 *
 * Heuristic: match runs of ASCII letters that are 3+ chars, dedupe,
 * and drop a small stoplist of English filler words that would crowd
 * out the actual signal.
 */
const AGENT_KEYWORD_STOPLIST = new Set([
  'the', 'and', 'you', 'your', 'are', 'for', 'with', 'this', 'that',
  'will', 'when', 'have', 'has', 'had', 'not', 'but', 'all', 'any',
  'can', 'cant', 'should', 'would', 'could', 'they', 'their', 'them',
  'our', 'use', 'using', 'used', 'ask', 'tell', 'say', 'said',
  'role', 'voice', 'agent', 'assistant', 'human', 'user',
  'system', 'prompt', 'reply', 'message', 'always', 'never',
  'short', 'long', 'good', 'great', 'fine', 'nice',
]);

function extractAgentKeywords(agent) {
  if (!agent) return [];
  const corpus = [
    agent.name || '',
    agent.firstMessage || '',
    agent.systemPrompt || '',
  ].join(' ');

  // Keep ASCII tokens that are 3+ chars and aren't pure stopwords.
  const tokens = corpus.match(/[A-Za-z][A-Za-z0-9'-]{2,}/g) || [];
  const keywords = [];
  const seen = new Set();
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (AGENT_KEYWORD_STOPLIST.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    keywords.push(lower);
    if (keywords.length >= 60) break; // Deepgram caps at ~100 total
  }
  return keywords;
}

/**
 * Create a Deepgram live connection wired up with this session's
 * full handler set (transcript, VAD, error, close).
 */
function createSessionDeepgramConn(session, { deepgramKey, language, audioConfig = null, isReconnect = false } = {}) {
  const agent = session.agent;
  const sttKeywords = [
    ...UNIVERSAL_HINGLISH_SEED,
    ...extractAgentKeywords(agent),
    ...(agent?.advanced?.sttKeywords || []),
  ].filter(Boolean);

  // Dedupe + cap at Deepgram's reasonable upper bound (100).
  const uniqueKeywords = [...new Set(sttKeywords.map(k => k.toLowerCase()))].slice(0, 100);

  // STT language: explicit `multi` preference for code-switching agents.
  // Pure 'hi' loses English words to Hindi phonetic mapping ("gym" -> "दिन").
  // Agent creators can set agent.language = 'multi' or 'hi-Latn' for proper
  // Hinglish handling. STT_PREFER_MULTI env upgrades 'hi' globally as a
  // safety net for any legacy agents that haven't been re-saved yet.
  let effectiveLanguage = language || agent?.language || 'en';
  const preferMulti = String(process.env.STT_PREFER_MULTI || 'false').toLowerCase() === 'true';
  if (preferMulti && effectiveLanguage === 'hi') {
    console.log(`[STT] Upgrading 'hi' -> 'multi' (STT_PREFER_MULTI=true) for better Hinglish recognition`);
    effectiveLanguage = 'multi';
  } else if (effectiveLanguage === 'hi' && !isReconnect) {
    console.warn(`[STT] ⚠ Agent language is 'hi' (pure Hindi). Users mixing English (gym/website/app) may be mis-transcribed. Consider 'multi' or 'hi-Latn'.`);
  }

  return deepgramService.createLiveConnection({
    apiKey: deepgramKey,
    language: effectiveLanguage,
    backgroundDenoising: agent?.advanced?.backgroundDenoising || 'default',
    keywords: uniqueKeywords,
    audioConfig,
    onVADEvent: buildSessionOnVADEvent(session),
    onTranscript: buildSessionOnTranscript(session),
    onError: (err) => {
      session.sttUnavailable = true;
      safeSend(session.ws, {
        type: 'error',
        message: `Deepgram Error: ${err?.message || 'Live transcription unavailable'}`,
      });
      safeSend(session.ws, {
        type: 'status',
        message: 'STT temporarily unavailable. Reconnecting...',
      });
      if (!isReconnect) trySttFallbackReconnect(session, deepgramKey);
    },
    onClose: (closeInfo) => {
      if (closeInfo && closeInfo.code && closeInfo.code !== 1000) {
        safeSend(session.ws, {
          type: 'status',
          message: `STT connection closed (code ${closeInfo.code}).`,
        });
        // Auto-reconnect on abnormal close (1006, 1011, 4xxx) if session still active
        if (session.status !== 'ended' && !isReconnect && session.enableStt) {
          console.log(`[Deepgram] Abnormal close (${closeInfo.code}) — auto-reconnecting in 500ms`);
          setTimeout(() => {
            if (session.status === 'ended') return;
            try {
              session.deepgramConn = createSessionDeepgramConn(session, {
                deepgramKey,
                language,
                audioConfig: session._lastAudioConfig || null,
                isReconnect: true,
              });
              session.sttUnavailable = false;
              safeSend(session.ws, { type: 'status', message: 'STT reconnected ✅' });
            } catch (e) {
              console.error('[Deepgram] Reconnect failed:', e.message);
            }
          }, 500);
        }
      }
    },
  });
}

function setupVoiceSession(wss) {
  wss.on('connection', (ws) => {
    const sessionId = uuidv4();
    let session = {
      id: sessionId,
      traceId: sessionId,
      ws,
      userId: null,
      agent: null,
      userSettings: {},
      history: [],
      startTime: Date.now(),
      audioBuffer: [],  // Accumulate audio chunks
      deepgramConn: null,
      callLogId: null,
      isProcessing: false,
      status: 'connected',
      currentGenerationId: null, // Track current AI generation
      latency: {
        turnStartedAt: null,
        llmStartedAt: null,
        firstTextChunkAt: null,
        firstAudioAt: null,
      },
      callLogWriteQueue: Promise.resolve(),
      prefersBinaryAudio: false,
      sttUnavailable: false,
      audioIngressWindowStartedAt: Date.now(),
      audioIngressBytesInWindow: 0,
      droppedAudioChunks: 0,
      warnedBackpressureAt: 0,
      sttRetryAttempted: false,
    };

    activeSessions.set(sessionId, session);
    console.log(`🔌 WebSocket connected: ${sessionId} (active: ${activeSessions.size}/${MAX_CONCURRENT_SESSIONS})`);
    touchSession(session);

    // Send ready ping
    safeSend(ws, { type: 'connected', sessionId });

    ws.on('message', async (rawData, isBinary) => {
      touchSession(session);
      try {
        if (isBinary) {
          await handleAudioChunkBinary(session, rawData);
          return;
        }
        const message = JSON.parse(rawData.toString());
        await handleMessage(session, message);
      } catch (error) {
        console.error(`❌ Session ${sessionId} error:`, error.message);
        safeSend(ws, { type: 'error', message: error.message });
      }
    });

    ws.on('close', async () => {
      await cleanupSession(session);
      activeSessions.delete(sessionId);
      console.log(`🔌 WebSocket disconnected: ${sessionId}`);
    });

    ws.on('error', (err) => {
      console.error(`❌ WebSocket error ${sessionId}:`, err.message);
    });
  });
}

function startIdleTimer(session) {
  if (session._idleTimer) clearTimeout(session._idleTimer);

  // Idle re-engagement is opt-in via env. When disabled (default 0), the
  // agent never spontaneously asks "are you still there?" — this avoids
  // a race we observed in production where the idle timer fires at the
  // same instant the user starts speaking, causing two parallel
  // processTranscript runs and queue-saturating Groq.
  const idleMs = Number(process.env.IDLE_REENGAGE_MS || 0);
  if (!idleMs || idleMs <= 0) return;

  session._idleTimer = setTimeout(() => {
    // Defense-in-depth: never re-engage on a dead/closing session,
    // and never if the user is already mid-turn.
    if (session.status === 'ended' || session.agentSpeaking || session.isProcessing) return;
    if (!session.ws || session.ws.readyState !== 1) return;
    if (!activeSessions.has(session.id)) return;
    // Skip if STT picked up anything in the last 2s — user just hasn't
    // hit speech_final yet.
    if (session._lastSttTranscript && session._lastSttTranscript.trim().length > 0) return;
    console.log(`[Idle] User silent for ${Math.round(idleMs / 1000)}s. Triggering active re-engagement.`);
    try {
      processTranscript(session, "[SYSTEM_EVENT: The user has been completely silent. Briefly and naturally ask if they are still there or if they need any help. DO NOT mention this system event.]");
    } catch (e) {
      console.error("Failed to trigger idle engagement:", e);
    }
  }, 10000);
}

async function handleMessage(session, message) {
  const { type } = message;

  switch (type) {
    case 'init':
      await handleInit(session, message);
      break;

    case 'audio':
      // Streaming audio chunks from browser mic
      await handleAudioChunk(session, message);
      break;

    case 'mic_config':
      // Browser reports actual AudioContext sample rate — reinitialize Deepgram with correct config
      await handleMicConfig(session, message);
      break;

    case 'end_audio':
      // User stopped speaking - process accumulated audio
      await handleAudioEnd(session);
      break;

    case 'text':
      // Text input for testing without microphone
      await handleTextInput(session, message.text);
      break;

    case 'interrupt':
    case 'barge_in':
      handleClientInterrupt(session);
      break;

    case 'end_session':
      await handleEndSession(session, 'user_hangup');
      break;

    case 'dtmf':
      // User pressed a phone keypad digit mid-call. Treat the digit
      // sequence as a transcript so the LLM (or CallFlow) can react —
      // useful for IVR-style menus ("Press 1 for sales, 2 for support").
      await handleDtmf(session, message);
      break;

    case 'language_switch':
      // User asked to switch language mid-call ("English mein baat karo").
      // Reinitialize Deepgram with the new language and update agent.language
      // so TTS and humanizeText pick up the right voice.
      await handleLanguageSwitch(session, message);
      break;

    case 'user_speech_start':
      // Frontend VAD detected speech start
      if (session.agentSpeaking) {
        // If we want to interrupt based on VAD alone, we could do it here.
        // But we rely on Deepgram transcript length for smarter interruption.
      }
      break;

    case 'user_speech_end':
      // Frontend VAD detected an audio silence. This is a useful "user may
      // have stopped" SIGNAL — but it must NOT immediately fire a response.
      // The frontend VAD endpoints far more aggressively than our smart
      // soft-commit window, so firing here directly was cutting users off
      // mid-thought (especially during natural pauses or mid-number).
      //
      // Route it through commitTranscript instead, so the SAME dynamic
      // window applies (800ms normal / 1500ms on connectors / 2400ms when a
      // number is still being dictated) and the merge/dedup logic runs. If
      // the user resumes, the window extends and we process ONE merged turn.
      if (!session.isProcessing && session._lastSttTranscript && session._lastSttTranscript.trim().length > 0) {
        const pendingTranscript = session._lastSttTranscript;
        const delayMs = Number(process.env.STT_VAD_FINALIZATION_DELAY_MS || 250);
        console.log(`[VAD] user_speech_end observed pending interim; waiting ${delayMs}ms for Deepgram speech_final: "${pendingTranscript}"`);

        if (session._vadFinalizationTimer) clearTimeout(session._vadFinalizationTimer);
        session._vadFinalizationTimer = setTimeout(() => {
          session._vadFinalizationTimer = null;
          if (session.isProcessing || session.agentSpeaking) return;
          if (session._softCommitBuffer && session._softCommitTimer) {
            bumpSoftCommitTimer(session);
            return;
          }

          const allowInterimFallback = String(process.env.STT_ALLOW_INTERIM_FALLBACK_COMMIT || 'false').toLowerCase() === 'true';
          if (!allowInterimFallback) {
            console.log('[VAD] No Deepgram speech_final after VAD end; not committing interim transcript');
            return;
          }

          const pending = session._lastSttTranscript;
          if (!pending || pending.trim().length < 2) return;
          console.warn(`[VAD] Interim fallback commit enabled; buffering: "${pending}"`);
          commitTranscript(session, pending);
        }, delayMs);
        const finalTranscript = session._lastSttTranscript;
        session._lastSttTranscript = '';
        console.log(`[VAD] user_speech_end → soft-commit window: "${finalTranscript}"`);
        commitTranscript(session, finalTranscript);
      }
      break;

    case 'ping':
      safeSend(session.ws, { type: 'pong' });
      break;

    default:
      console.warn('Unknown message type:', type);
  }
}

async function handleMicConfig(session, message) {
  const {
    sampleRate,
    encoding = 'linear16',
    channels = 1,
    audioInputMode = 'raw',
    mimeType = 'audio/webm;codecs=opus',
  } = message;
  if (!session.agent || !session.enableStt) return;

  const normalizedInputMode = String(audioInputMode || 'raw').toLowerCase();
  const normalizedSampleRate = Number(sampleRate || (normalizedInputMode === 'webm' ? 48000 : process.env.DEEPGRAM_SAMPLE_RATE || 48000));
  const normalizedEncoding = normalizedInputMode === 'webm' ? 'opus' : encoding;

  const configuredRate = Number(process.env.DEEPGRAM_SAMPLE_RATE || 48000);
  const configuredEncoding = process.env.DEEPGRAM_ENCODING || 'linear16';
  const configuredInputMode = String(process.env.DEEPGRAM_AUDIO_INPUT_MODE || 'webm').toLowerCase();
  const effectiveConfiguredEncoding = configuredInputMode === 'webm' ? 'container' : configuredEncoding;
  const effectiveBrowserEncoding = normalizedInputMode === 'webm' ? 'container' : normalizedEncoding;

  console.log(`[MicConfig] Browser: mode=${normalizedInputMode} ${normalizedEncoding}@${normalizedSampleRate}Hz | Deepgram configured: mode=${configuredInputMode} ${effectiveConfiguredEncoding}@${configuredRate}Hz`);

  // If the rates already match, DON'T reinitialize — the handleInit connection is already
  // open and working. Reinitializing would close it and drop audio during reconnect.
  const configAlreadyMatches = normalizedInputMode === configuredInputMode && (
    normalizedInputMode === 'webm'
      || (normalizedSampleRate === configuredRate && effectiveBrowserEncoding === effectiveConfiguredEncoding)
  );

  if (configAlreadyMatches) {
    console.log(`[MicConfig] Rates match — keeping existing Deepgram connection ✅`);
    safeSend(session.ws, { type: 'status', message: `STT ready (${normalizedInputMode}, ${normalizedSampleRate}Hz)` });
    return;
  }

  // Rates mismatch — need to reinitialize with correct rate
  console.log(`[MicConfig] Rate mismatch — reinitializing Deepgram connection...`);

  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (_) {}
    session.deepgramConn = null;
  }

  session.sttUnavailable = false;
  session.sttRetryAttempted = false;

  const deepgramKey = session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
  const sttLanguage = session.agent.language || 'en';

  // Pass audio config directly — never mutate process.env (race condition for concurrent sessions).
  const audioConfig = {
    encoding: normalizedEncoding,
    sampleRate: String(normalizedSampleRate),
    channels: String(channels),
    audioInputMode: normalizedInputMode,
    mimeType,
  };

  // Save for auto-reconnect on idle close
  session._lastAudioConfig = audioConfig;
  session._deepgramKey = deepgramKey;
  session._sttLanguage = sttLanguage;

  // FIX: use the shared session handler factory so interruption,
  // backchanneling, silence-timer fallback and idle timer all keep
  // working after mic_config — previously this path used a stripped-down
  // handler and silently downgraded the call experience.
  session.deepgramConn = createSessionDeepgramConn(session, {
    deepgramKey,
    language: sttLanguage,
    audioConfig,
  });

  console.log(`[MicConfig] Deepgram reinitialized: mode=${normalizedInputMode} ${normalizedEncoding}@${normalizedSampleRate}Hz (no env mutation)`);
  safeSend(session.ws, { type: 'status', message: `STT ready (${normalizedInputMode}, ${normalizedSampleRate}Hz)` });
}


async function handleInit(session, message) {
  const { agentId, token, preferBinaryAudio, enableStt = true, skipPostCallAnalysis = false, streamProtocol = false } = message;

  // Verify JWT token
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    throw new Error('Invalid or expired token. Please log in again.');
  }

  // Load user
  const user = await User.findById(decoded.id);
  if (!user) throw new Error('User not found');

  // Load agent - widget tokens include agentId and bypass ownership check
  let agent;
  if (decoded.type === 'widget') {
    agent = await Agent.findOne({ _id: decoded.agentId, status: 'active' });
    if (!agent) throw new Error('Agent not found or inactive');
  } else {
    agent = await Agent.findOne({ _id: agentId, userId: user._id });
    if (!agent) throw new Error('Agent not found or not authorized');
  }

  session.userId = user._id;
  session.agent = agent;
  session.userSettings = user.settings || {};
  session.prefersBinaryAudio = !!preferBinaryAudio;
  session.enableStt = enableStt !== false;
  session.streamProtocol = !!streamProtocol;
  session.skipPostCallAnalysis = !!skipPostCallAnalysis;
  session.status = 'ready';
  
  if (agent.workflowId) {
    session.callFlow = await CallFlow.findById(agent.workflowId);
    if (session.callFlow) {
      console.log(`[Flow] Loaded Call Flow: ${session.callFlow.name}`);
    }
  }
  
  // Fetch User Memory (Retell/Vapi style)
  const UserMemory = require('../models/UserMemory');
  const userPhone = session.callParams?.from || 'test_user'; // Default for test agent
  const memory = await UserMemory.findOne({ userId: user._id, phone: userPhone });
  session.memory = memory;

  if (session.enableStt) {
    // Set up live Deepgram Connection for continuous transcription
    const deepgramKey = session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
    if (!deepgramKey) {
      throw new Error('⚠️ No Deepgram API key configured. Please add DEEPGRAM_API_KEY to your .env file. Get $200 free credits at https://deepgram.com');
    }
    
    // Validate API key format - Deepgram supports two formats:
    // Legacy: 40-char hex (e.g. 7ee245f531db82f59df59ecae82f906f5eac89e1)
    // New: sk-xxx format
    if (deepgramKey.length < 20) {
      console.warn('⚠️ Deepgram API key appears to be too short. Please check your .env configuration.');
      safeSend(session.ws, {
        type: 'status',
        message: '⚠️ Deepgram API key appears invalid. Please check your configuration.',
      });
    }

    // Use the agent's configured language for STT (hindi = 'hi', english = 'en', multilingual = 'multi')
    const sttLanguage = agent.language || 'en';
    console.log(`🌐 Agent language: ${sttLanguage}`);

    // Save key for later reconnects (used by createSessionDeepgramConn auto-reconnect path)
    session._deepgramKey = deepgramKey;
    session._sttLanguage = sttLanguage;

    // Use shared helper so handleMicConfig + reconnects share identical behaviour.
    session.deepgramConn = createSessionDeepgramConn(session, {
      deepgramKey,
      language: sttLanguage,
    });
  }

  // Pre-warm TTS in parallel with everything else. The cache lookup in
  // ttsService is keyed on (text, voiceId, speed, provider), so warming
  // the firstMessage NOW means the actual greeting TTS lookup below is
  // a free instant cache hit (~5ms vs 200-300ms cold). Agent-language
  // fillers (Hmm, Okay, Haan) are also pre-warmed so backchannels and
  // tool-check phrases hit cache through the rest of the call.
  // Fire-and-forget — don't block init on this.
  (async () => {
    try {
      const lang = agent.language || 'en';
      const voiceId = agent.voice?.voiceId || 'en-US-JennyNeural';
      const provider = agent.voice?.provider || 'edge-tts';
      const speed = agent.voice?.speed || 1.05;
      // Use the SAME filler list and SAME fillerSpeed the pipeline will look
      // up at runtime, otherwise the cache keys won't match and the instant-
      // filler optimization silently misses every time.
      const pipelineFillers = (voicePipeline._fillersByLang && voicePipeline._fillersByLang[lang])
        || (voicePipeline._fillersByLang && voicePipeline._fillersByLang['en'])
        || ['Hmm...', 'Okay...', 'Right.'];
      const fillerSpeed = Math.max(0.85, speed - 0.15);

      // Warm the greeting at normal speed (used as-is).
      if (agent.firstMessage) {
        ttsService.textToSpeech({ text: agent.firstMessage, voiceId, speed, provider }).catch(() => {});
      }
      // Warm each filler at BOTH the lookup speed (for the instant filler) and
      // normal speed (for backchannels/tool-check phrases).
      for (const phrase of pipelineFillers) {
        ttsService.textToSpeech({ text: phrase, voiceId, speed: fillerSpeed, provider }).catch(() => {});
        ttsService.textToSpeech({ text: phrase, voiceId, speed, provider }).catch(() => {});
      }
    } catch (_) { /* swallow — pre-warm is best-effort */ }
  })();

  // Create initial call log
  const callLog = await CallLog.create({
    userId: user._id,
    agentId: agent._id,
    agentName: agent.name,
    direction: 'web',
    status: 'ongoing',
    sessionId: session.id,
    startTime: new Date(),
    transcript: [],
  });
  session.callLogId = callLog._id;

  safeSend(session.ws, {
    type: 'status',
    message: '🎙️ Agent initialized. Generating greeting...'
  });

  // Get first message audio
  try {
    let firstMessageText = '';
    
    if (session.callFlow) {
      // Execute the first nodes of the CallFlow
      const stream = callFlowEngine.processFlowStep(session, '', session.callFlow);
      for await (const chunk of stream) {
        if (chunk.type === 'chunk') {
           firstMessageText += chunk.text + ' ';
        } else if (chunk.type === 'transfer') {
           // Handle immediate transfer if any
           safeSend(session.ws, { type: 'transfer_initiated', transferTo: chunk.transferTo, reason: chunk.reason });
           return;
        } else if (chunk.type === 'end_call') {
           handleEndSession(session, 'flow_ended');
           return;
        }
      }
      
      firstMessageText = firstMessageText.trim();
      if (!firstMessageText) firstMessageText = "Hello."; // Fallback if flow had no speak node
      
      const ttsService = require('../services/ttsService');
      const audioBuffer = await ttsService.textToSpeech({
        text: firstMessageText,
        voiceId: agent.voice?.voiceId || 'en-US-JennyNeural',
        provider: agent.voice?.provider || 'edge-tts',
      });
      
      // Add to history
      session.history.push({ role: 'assistant', content: firstMessageText, timestamp: new Date() });
      queueCallLogUpdate(session, {
        $push: { transcript: { role: 'assistant', content: firstMessageText } }
      }, 'first_message_flow');

      safeSend(session.ws, { 
        type: 'response_text', 
        text: firstMessageText, 
        isFirstMessage: true,
        ambientNoise: agent.advanced?.ambientNoise || 'none'
      });

      if (audioBuffer && audioBuffer.length > 0) {
        sendAudioBuffer(session, audioBuffer);
      }
    } else {
      // Standard Voice Pipeline
      const { text, audioBuffer } = await voicePipeline.getFirstMessageAudio(agent);
      firstMessageText = text;

      // Add to history
      session.history.push({ role: 'assistant', content: text, timestamp: new Date() });

      // Update call log
      queueCallLogUpdate(session, {
        $push: { transcript: { role: 'assistant', content: text } }
      }, 'first_message_standard');

      // Send text first with ambient noise config
      safeSend(session.ws, { 
        type: 'response_text', 
        text, 
        isFirstMessage: true,
        ambientNoise: agent.advanced?.ambientNoise || 'none'
      });

      // Send audio
      if (audioBuffer && audioBuffer.length > 0) {
        sendAudioBuffer(session, audioBuffer);
      }
    }

    safeSend(session.ws, {
      type: 'ready',
      sessionId: session.id,
      agentName: agent.name,
      firstMessage: firstMessageText,
      ambientNoise: agent.advanced?.ambientNoise || 'none',
    });

    session.status = 'listening';
    startIdleTimer(session);

    // Mid-call server event — fire AFTER ready so the customer doesn't
    // pay the (small) cost of a slow webhook handshake on TTFA.
    serverEvents.emit(session, 'call.started', {
      agentName: agent.name,
      language: agent.language || 'en',
      direction: 'web',
      firstMessage: firstMessageText,
    });

  } catch (error) {
    throw new Error('Failed to initialize agent: ' + error.message);
  }
}

async function handleAudioChunk(session, message) {
  if (!session.agent || !session.deepgramConn || session.sttUnavailable) return;

  // Stream directly to deepgram
  const audioData = Buffer.from(message.data, 'base64');
  if (!allowAudioIngress(session, audioData.length)) return;
  try {
    session.deepgramConn.send(audioData);
  } catch (e) {
    console.error("Failed to send chunk to deepgram:", e);
  }
}

async function handleAudioChunkBinary(session, rawData) {
  if (!session.agent || !session.deepgramConn || session.sttUnavailable) return;

  try {
    const audioData = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
    if (!allowAudioIngress(session, audioData.length)) return;
    session.deepgramConn.send(audioData);
  } catch (e) {
    console.error("Failed to send binary chunk to deepgram:", e);
  }
}

async function handleAudioEnd(session) {
  // Obsolete in Live mode, but keeping endpoint for graceful stop
}

async function handleTextInput(session, text) {
  if (!session.agent) {
    throw new Error('Session not initialized. Please send an init message first.');
  }
  if (!text || typeof text !== 'string' || text.trim() === '') return;
  // processTranscript owns the atomic isProcessing guard + latency timers.
  await processTranscript(session, text.trim());
}

function handleClientInterrupt(session) {
  session.currentGenerationId = uuidv4();
  // Cancel any in-flight LLM HTTP request so it frees its slot.
  if (session._currentAbortController) {
    try { session._currentAbortController.abort(); } catch (_) {}
    session._currentAbortController = null;
  }
  session.agentSpeaking = false;
  session.isProcessing = false;

  // Clear soft-commit state — explicit user interrupt means whatever was
  // buffered is stale (different turn now).
  // Keep STT buffers intact so barge-in speech can still finalize.

  if (session._silenceTimer) {
    clearTimeout(session._silenceTimer);
    session._silenceTimer = null;
  }
  if (session._agentSpeakingTimer) {
    clearTimeout(session._agentSpeakingTimer);
    session._agentSpeakingTimer = null;
  }

  safeSend(session.ws, { type: 'interrupt' });
  safeSend(session.ws, { type: 'clear_audio' });
}

/**
 * DTMF (keypad) input mid-call.
 *
 * Two modes:
 *   1. Capture mode — frontend/Twilio sends a sequence ("1234") and we
 *      treat it as a single transcript so the agent / CallFlow can react.
 *   2. Buffered mode — single digits accumulate into session._dtmfBuffer
 *      and flush after DTMF_FLUSH_MS of silence. Useful when the user is
 *      entering a multi-digit code one digit at a time.
 *
 * Message shape: { type: 'dtmf', digit?: '1', digits?: '1234', flush?: true }
 */
async function handleDtmf(session, message) {
  if (!session.agent) return;
  const single = String(message.digit ?? '').replace(/[^0-9*#]/g, '');
  const batch  = String(message.digits ?? '').replace(/[^0-9*#]/g, '');
  const incoming = batch || single;
  if (!incoming) return;

  const flushMs = Number(process.env.DTMF_FLUSH_MS || 1500);
  if (!session._dtmfBuffer) session._dtmfBuffer = '';
  session._dtmfBuffer += incoming;

  if (session._dtmfFlushTimer) clearTimeout(session._dtmfFlushTimer);

  // If frontend explicitly asked for flush (e.g. user pressed #) or sent a
  // batched sequence, process immediately. Otherwise debounce.
  const shouldFlushNow = !!message.flush || batch.length > 0 || incoming.includes('#');
  const finalize = async () => {
    const digits = session._dtmfBuffer;
    session._dtmfBuffer = '';
    session._dtmfFlushTimer = null;
    if (!digits) return;

    safeSend(session.ws, { type: 'dtmf_received', digits });
    queueCallLogUpdate(session, {
      $push: { transcript: { role: 'user', content: `[DTMF: ${digits}]` } }
    }, 'dtmf_input');

    // Stop the agent if it was talking — DTMF is an explicit user signal.
    if (session.agentSpeaking) handleClientInterrupt(session);

    // Hand the digit string to the normal pipeline. The LLM will see
    // "[User pressed: 1234]" and route accordingly. If a CallFlow is
    // active, the flow engine can read session._lastDtmf for branching.
    session._lastDtmf = digits;
    if (!session.isProcessing) {
      session.isProcessing = true;
      session.latency.turnStartedAt = Date.now();
      session.latency.llmStartedAt = null;
      session.latency.firstTextChunkAt = null;
      session.latency.firstAudioAt = null;
      try {
        await processTranscript(session, `[User pressed keypad: ${digits}]`);
      } catch (e) {
        console.error('DTMF processing error:', e);
        session.isProcessing = false;
      }
    }
  };

  if (shouldFlushNow) {
    await finalize();
  } else {
    session._dtmfFlushTimer = setTimeout(finalize, flushMs);
  }
}

/**
 * Mid-call language switch.
 *
 * Reinitializes Deepgram with the new language and updates agent.language
 * so subsequent TTS picks the right voice and humanizeText applies the
 * correct Hinglish substitutions. The agent doc itself is NOT persisted —
 * we only mutate the in-session copy.
 *
 * Message shape: { type: 'language_switch', language: 'hi'|'en'|'multi'|... , voiceId?: '...' }
 */
async function handleLanguageSwitch(session, message) {
  if (!session.agent || !session.deepgramConn) return;
  const newLang = String(message.language || '').trim();
  if (!newLang) {
    safeSend(session.ws, { type: 'error', message: 'language_switch requires a language code' });
    return;
  }

  const supported = ['en', 'en-IN', 'hi', 'hi-Latn', 'multi', 'ta', 'te', 'kn', 'ml', 'mr', 'gu', 'bn', 'ur', 'pa'];
  if (!supported.includes(newLang)) {
    safeSend(session.ws, { type: 'error', message: `Unsupported language: ${newLang}` });
    return;
  }

  console.log(`[LanguageSwitch] ${session.agent.language || 'en'} → ${newLang}`);

  // Tear down the old Deepgram connection cleanly.
  try { session.deepgramConn.finish(); } catch (_) {}
  session.deepgramConn = null;

  // Mutate in-session agent (don't persist to DB — caller may want this
  // to be temporary for one call only).
  session.agent.language = newLang;
  if (message.voiceId) {
    session.agent.voice = session.agent.voice || {};
    session.agent.voice.voiceId = message.voiceId;
  }
  session._sttLanguage = newLang;

  // Reopen Deepgram with the new language. Reuse whatever audio config
  // mic_config last established so we don't drop frames during the swap.
  try {
    const deepgramKey = session._deepgramKey || session.userSettings?.deepgramKey || process.env.DEEPGRAM_API_KEY;
    session.deepgramConn = createSessionDeepgramConn(session, {
      deepgramKey,
      language: newLang,
      audioConfig: session._lastAudioConfig || null,
    });
    session.sttUnavailable = false;
    session.sttRetryAttempted = false;
    safeSend(session.ws, {
      type: 'language_switched',
      language: newLang,
      voiceId: session.agent.voice?.voiceId || null,
    });
  } catch (e) {
    console.error('[LanguageSwitch] Reconnect failed:', e.message);
    safeSend(session.ws, { type: 'error', message: `Language switch failed: ${e.message}` });
  }
}

async function processTranscript(session, transcript) {
  // ── Atomic re-entrancy guard ───────────────────────────────────────────
  // MUST be the first synchronous statements (before any await). Node runs
  // this check+set without interruption, so two concurrent entry points
  // (VAD `user_speech_end` firing at the same instant as the soft-commit
  // timer) can no longer BOTH start a turn — which previously double-fired
  // the LLM, double-pushed history, and queued two Groq streams.
  if (session.isProcessing) {
    console.log('[processTranscript] Skipped — a turn is already in progress');
    return;
  }
  if (!session.agent || !transcript || typeof transcript !== 'string' || transcript.trim() === '') {
    return;
  }
  session.isProcessing = true;
  session.latency.turnStartedAt = Date.now();
  session.latency.llmStartedAt = null;
  session.latency.firstTextChunkAt = null;
  session.latency.firstAudioAt = null;

  try {
    // Cancel any ongoing generation — both via the generationId guard
    // (sync, used by audio queue) and an AbortController (HTTP-level,
    // actually frees the upstream Groq SDK connection slot so a new
    // request doesn't queue behind a half-dead old one).
    if (session._currentAbortController) {
      try { session._currentAbortController.abort(); } catch (_) {}
    }
    const abortController = new AbortController();
    session._currentAbortController = abortController;

    const generationId = uuidv4();
    session.currentGenerationId = generationId;

    // Send transcript to client
    safeSend(session.ws, {
      type: 'transcript',
      text: transcript,
      isFinal: true,
      role: 'user',
    });

    // Handle Backchanneling (Vapi/Retell style) — NON-BLOCKING to avoid delaying LLM
    if (session.agent.advanced?.backchanneling) {
      const backchannel = voicePipeline.getBackchannel(transcript);
      if (backchannel) {
        console.log(`[Backchannel] Sending (async): ${backchannel}`);
        ttsService.textToSpeech({
          text: backchannel,
          voiceId: session.agent.voice?.voiceId,
          speed: 1.2,
          apiKey: session.userSettings.ttsKey || process.env.ELEVENLABS_API_KEY,
          provider: session.agent.voice?.provider || 'edge-tts',
        }).then(audio => {
          if (audio && session.currentGenerationId === generationId) {
            sendAudioChunkOnly(session, audio);
          }
        }).catch(e => console.error('[Backchannel TTS Error]', e.message));
      }
    }

    // Check for end call
    if (voicePipeline.shouldEndCall(transcript, session.agent)) {
      await handleEndSession(session, 'user_hangup');
      return;
    }

    // Add user message to history
    session.history.push({ role: 'user', content: transcript, timestamp: new Date() });

    // Update call log
    queueCallLogUpdate(session, {
      $push: { transcript: { role: 'user', content: transcript } }
    }, 'user_transcript');

    // Mid-call event — every user utterance is forwarded to subscribers
    serverEvents.emit(session, 'transcript.segment', {
      role: 'user',
      content: transcript,
      ts: new Date().toISOString(),
    });

    // 🔴 REAL-TIME SENTIMENT ANALYSIS + 📚 RAG CONTEXT FETCH (parallel, non-blocking for sentiment)
    // Sentiment is fully fire-and-forget. RAG must be awaited because the LLM needs the
    // context, but kicking it off here in parallel with sentiment shaves 100-300ms vs.
    // the old order (sentiment .then() → RAG await).
    const sentimentPromise = voicePipeline.classifySentiment(transcript)
      .then(async (sentimentResult) => {
        // Send live sentiment to frontend
        safeSend(session.ws, {
          type: 'sentiment',
          sentiment: sentimentResult.sentiment,
          score: sentimentResult.score,
          text: transcript.substring(0, 100),
        });

        // Track sentiment history on session for transfer checks
        if (!session.sentimentHistory) session.sentimentHistory = [];
        const prev = session.sentimentHistory[session.sentimentHistory.length - 1];
        session.sentimentHistory.push({
          sentiment: sentimentResult.sentiment,
          score: sentimentResult.score,
          timestamp: new Date(),
        });

        // Mid-call server event — fire ONLY on transitions so receivers
        // don't get spammed with every neutral repeat.
        if (!prev || prev.sentiment !== sentimentResult.sentiment) {
          serverEvents.emit(session, 'sentiment.shift', {
            from: prev?.sentiment || null,
            to: sentimentResult.sentiment,
            score: sentimentResult.score,
            text: transcript.substring(0, 200),
          });
        }

        // Save to call log sentiment timeline
        if (session.callLogId) {
          await CallLog.findByIdAndUpdate(session.callLogId, {
            $push: {
              liveSentimentTimeline: {
                timestamp: new Date(),
                sentiment: sentimentResult.sentiment,
                score: sentimentResult.score,
                text: transcript.substring(0, 200),
              },
            },
          }).catch(e => console.error('Sentiment save error:', e.message));
        }
        return sentimentResult;
      })
      .catch(e => { console.error('Sentiment analysis error:', e.message); return null; });

    // Kick off RAG in parallel — we'll await it just before invoking the pipeline.
    const _ragStart = Date.now();
    const ragPromise = (session.agent?.knowledgeBaseId
      ? ragService.getContextForQuery(transcript, session.agent.knowledgeBaseId)
          .then(ctx => {
            if (ctx) console.log(`[RAG] Retrieved context for session ${session.id} (${Date.now() - _ragStart}ms)`);
            return ctx || '';
          })
          .catch(e => { console.error('[RAG] Context retrieval error:', e.message); return ''; })
      : Promise.resolve(''));

    // 🔄 HUMAN HANDOFF CHECK
    // Check if call should be transferred to a human agent
    if (session.agent?.transferNumber) {
      const transferCheck = voicePipeline.shouldTransfer({
        transcript: session.history,
        sentimentHistory: session.sentimentHistory || [],
        agent: session.agent,
      });

      if (transferCheck.shouldTransfer) {
        console.log(`[🔄 Transfer] Session ${session.id} → ${session.agent.transferNumber} (${transferCheck.reason})`);

        // Send transfer event to frontend
        safeSend(session.ws, {
          type: 'transfer_initiated',
          transferTo: session.agent.transferNumber,
          reason: transferCheck.reason,
          context: `Call transferred after ${session.history.length} messages. Reason: ${transferCheck.reason}`,
        });

        // Mid-call server event for external systems (CRM/ticketing)
        serverEvents.emit(session, 'transferred', {
          kind: 'human',
          to: session.agent.transferNumber,
          reason: transferCheck.reason,
          messagesBeforeTransfer: session.history.length,
        });

        // Update call log
        if (session.callLogId) {
          await CallLog.findByIdAndUpdate(session.callLogId, {
            transferredTo: session.agent.transferNumber,
            transferReason: transferCheck.reason,
          }).catch(e => console.error('Transfer log error:', e.message));
        }



        // Say transfer message and end
        const transferMsg = `I'm going to connect you with a team member who can better assist you. Please hold for a moment.`;
        safeSend(session.ws, { type: 'response_text', text: transferMsg });

        try {
          const ttsService = require('../services/ttsService');
          const audioBuffer = await ttsService.textToSpeech({
            text: transferMsg,
            voiceId: session.agent.voice?.voiceId || 'en-US-JennyNeural',
            provider: session.agent.voice?.provider || 'edge-tts',
          });
          if (audioBuffer && audioBuffer.length > 0) {
            sendAudioBuffer(session, audioBuffer);
          }
        } catch (e) {}

        // End session after transfer message
        setTimeout(() => handleEndSession(session, 'transferred'), 3000);
        return;
      }
    }

    // Store sentiment history on session for transfer checks
    if (!session.sentimentHistory) session.sentimentHistory = [];

    safeSend(session.ws, { type: 'status', message: '💭 AI is thinking...' });
    session.latency.llmStartedAt = Date.now();
    console.log(`[⏱️ LATENCY] STT→Pipeline: ${session.latency.llmStartedAt - session.latency.turnStartedAt}ms`);

    // RAG was kicked off in parallel with sentiment above. Now await it
    // (sentiment continues in the background and is not blocking).
    const ragContext = await ragPromise;
    if (session.agent?.knowledgeBaseId) {
      console.log(`[⏱️ LATENCY] RAG lookup (parallel): ${Date.now() - _ragStart}ms`);
    }

    // Process through voice pipeline using STREAMING (Much faster) or Call Flow Engine
    let stream;
    if (session.callFlow) {
      stream = callFlowEngine.processFlowStep(session, transcript, session.callFlow);
    } else {
      // FIX: Send full history — voicePipeline.compressHistory() handles
      // rolling summary compression. Slicing to 10 here was preventing the
      // compressor from ever seeing older messages (threshold is 12).
      stream = voicePipeline.processTextStream({
        text: transcript,
        agent: session.agent,
        history: session.history,
        userSettings: session.userSettings,
        memory: session.memory,
        ragContext,
        abortSignal: abortController.signal,
        sessionId: session.id,
        callContext: {
          callLogId: session.callLogId,
          callerPhone: session.callParams?.from || '',
        },
      });
    }

    let fullResponseText = '';
    
    for await (const chunk of stream) {
      // If a new generation has started, stop this one immediately
      if (session.currentGenerationId !== generationId) {
        console.log(`[Interrupt] Stopping old generation: ${generationId}`);
        return;
      }

      if (chunk.type === 'chunk') {
        // Re-check after async TTS — user may have interrupted during TTS generation
        if (session.currentGenerationId !== generationId) {
          console.log(`[Interrupt] Aborting chunk send for old generation: ${generationId}`);
          return;
        }

        if (!session.latency.firstTextChunkAt) {
          session.latency.firstTextChunkAt = Date.now();
          console.log(`[⏱️ LATENCY] Pipeline→FirstText: ${session.latency.firstTextChunkAt - session.latency.llmStartedAt}ms | Total STT→Text: ${session.latency.firstTextChunkAt - session.latency.turnStartedAt}ms`);
          emitLatencyMetrics(session, 'first_text_chunk');
        }

        if (session.streamProtocol) {
          safeSend(session.ws, {
            type: 'text_stream',
            content: chunk.text,
          });
        } else {
          safeSend(session.ws, {
            type: 'response_text_chunk',
            text: chunk.text,
          });
        }

        fullResponseText += chunk.text + ' ';

        let audioToPlay = chunk.audio;
        if (!audioToPlay && session.callFlow && chunk.text) {
           const ttsService = require('../services/ttsService');
           try {
              audioToPlay = await ttsService.textToSpeech({
                 text: chunk.text,
                 voiceId: session.agent.voice?.voiceId || 'en-US-JennyNeural',
                 provider: session.agent.voice?.provider || 'edge-tts',
              });
           } catch (e) {
              console.error('[Flow TTS Error]', e);
           }
        }

        // Final interrupt check before sending audio
        if (session.currentGenerationId !== generationId) {
          console.log(`[Interrupt] Aborting audio send for old generation: ${generationId}`);
          return;
        }

        if (audioToPlay && audioToPlay.length > 0) {
           sendAudioBuffer(session, audioToPlay, false); // false = don't send audio_end yet
        }
      } else if (chunk.type === 'final') {
        fullResponseText = chunk.fullText;
      } else if (chunk.type === 'tool_called') {
        // Mid-call server event — fire when the LLM invokes a tool so
        // CRM/ticketing systems can react in real time (without waiting
        // for the post-call webhook).
        serverEvents.emit(session, 'tool.called', {
          toolName: chunk.toolName,
          args: chunk.args,
          result: chunk.result,
        });
      } else if (chunk.type === 'transfer') {
        safeSend(session.ws, { type: 'transfer_initiated', transferTo: chunk.transferTo, reason: chunk.reason });
      } else if (chunk.type === 'transfer_agent') {
        console.log(`[🔄 Multi-Agent Squad] Transferring session ${session.id} to agent ${chunk.agentId} (${chunk.reason})`);
        safeSend(session.ws, { type: 'transfer_initiated', transferToAgent: chunk.agentId, reason: chunk.reason });

        const newAgent = await Agent.findById(chunk.agentId);
        if (newAgent) {
          // Build a handoff summary so the destination agent doesn't have
          // to ask the customer to repeat themselves. We use a fast Groq
          // call (best-effort — even if it fails, we still hand off the
          // last 6 messages verbatim).
          let handoffSummary = '';
          try {
            const summary = await voicePipeline.compressHistory(session.history);
            handoffSummary = summary?.summary || '';
          } catch (_) { /* ignore */ }

          const recentMessages = session.history.slice(-6);
          const handoffContext = [
            handoffSummary ? `Earlier conversation summary:\n${handoffSummary}` : '',
            `Last few messages:\n${recentMessages.map(m => `${m.role}: ${m.content}`).join('\n')}`,
            `Reason for transfer: ${chunk.reason}`,
            (newAgent.squad?.handoffPrompt || 'You are continuing this call. Acknowledge the context briefly, then help.'),
          ].filter(Boolean).join('\n\n');

          // Mid-call server event — log the squad handoff for analytics
          serverEvents.emit(session, 'transferred', {
            kind: 'squad',
            fromAgentId: session.agent?._id?.toString?.(),
            toAgentId: chunk.agentId,
            reason: chunk.reason,
            handoffSummary,
            messagesBeforeTransfer: session.history.length,
          });

          const transferMsg = `I will transfer you to ${newAgent.name}. Please hold.`;
          safeSend(session.ws, { type: 'response_text', text: transferMsg });

          try {
            const ttsService = require('../services/ttsService');
            const audioBuffer = await ttsService.textToSpeech({
              text: transferMsg,
              voiceId: session.agent.voice?.voiceId || 'en-US-JennyNeural',
              provider: session.agent.voice?.provider || 'edge-tts',
            });
            if (audioBuffer && audioBuffer.length > 0) sendAudioBuffer(session, audioBuffer);
          } catch (e) {}

          // Swap agent. Inject the handoff context as a system message so
          // the next LLM call has the full picture without re-prompting.
          session.agent = newAgent;
          session.history.push({
            role: 'system',
            content: `[SQUAD HANDOFF]\n${handoffContext}`,
          });

          // Trigger new greeting after a short delay
          setTimeout(async () => {
            const { text, audioBuffer } = await voicePipeline.getFirstMessageAudio(session.agent);
            session.history.push({ role: 'assistant', content: text, timestamp: new Date() });
            safeSend(session.ws, { type: 'response_text', text, isFirstMessage: true });
            if (audioBuffer && audioBuffer.length > 0) sendAudioBuffer(session, audioBuffer);
          }, 3000);
        } else {
          safeSend(session.ws, { type: 'error', message: 'Destination agent not found.' });
        }
      } else if (chunk.type === 'end_call') {
        setTimeout(() => handleEndSession(session, 'flow_ended'), 2000);
      }
    }
    
    // Send a final empty buffer with isFinal=true to trigger the end of stream logic
    // This will send 'audio_end' and correctly start the _agentSpeakingTimer based on accumulated audio duration.
    sendAudioBuffer(session, Buffer.alloc(0), true);

    // If no audio was generated/sent at all, start the idle timer immediately.
    // Otherwise, sendAudioBuffer has already set a timer based on the actual audio duration.
    if (!session.agentSpeaking) {
      startIdleTimer(session);
    }

    fullResponseText = fullResponseText.trim();

    // Add AI response to history
    session.history.push({ role: 'assistant', content: fullResponseText, timestamp: new Date() });

    // Update call log
    queueCallLogUpdate(session, {
      $push: { transcript: { role: 'assistant', content: fullResponseText } }
    }, 'assistant_transcript');

    if (session.streamProtocol) {
      safeSend(session.ws, { type: 'text_stream_end', content: fullResponseText });
    } else {
      safeSend(session.ws, {
        type: 'response_text',
        text: fullResponseText,
      });
    }

    session.status = 'listening';
    safeSend(session.ws, { type: 'status', message: '🎙️ Listening...' });

  } catch (error) {
    console.error('Pipeline error:', error);

    // Last-resort: speak the canned fallback so the user hears SOMETHING
    // instead of a stuck "AI is thinking..." spinner. We tried Groq, we
    // tried Gemini — both failed. The canned reply (cache → template →
    // apology) lets the call stay alive for the next turn.
    try {
      const llmFallback = require('../services/llmFallback');
      const fallback = llmFallback.getReply(transcript, session.agent);
      safeSend(session.ws, { type: 'response_text', text: fallback.text });
      session.history.push({ role: 'assistant', content: fallback.text, timestamp: new Date() });
      queueCallLogUpdate(session, {
        $push: { transcript: { role: 'assistant', content: fallback.text } }
      }, 'assistant_fallback');

      const audio = await ttsService.textToSpeech({
        text: fallback.text,
        voiceId: session.agent.voice?.voiceId,
        provider: session.agent.voice?.provider || 'edge-tts',
      });
      if (audio && audio.length > 0) sendAudioBuffer(session, audio);
    } catch (e) {
      console.error('Last-resort fallback also failed:', e.message);
    }

    // CRITICAL: reset status so the UI doesn't stick on "AI is thinking".
    safeSend(session.ws, { type: 'error', message: 'AI processing failed: ' + error.message });
    safeSend(session.ws, { type: 'status', message: '🎙️ Listening...' });
    session.status = 'listening';
    session.agentSpeaking = false;
  } finally {
    session.isProcessing = false;
    if (session._currentAbortController) {
      session._currentAbortController = null;
    }
  }
}

async function handleEndSession(session, reason = 'user_hangup') {
  if (session.status === 'ended') return;
  if (session._idleTimer) clearTimeout(session._idleTimer);
  if (session._logFlushInterval) {
    clearInterval(session._logFlushInterval);
    session._logFlushInterval = null;
  }
  session.status = 'ended';

  // Send goodbye if not already
  if (reason === 'user_hangup' && session.agent) {
    const endMsg = session.agent.endCallMessage || 'Goodbye! Have a great day!';
    safeSend(session.ws, { type: 'response_text', text: endMsg, isEndMessage: true });
    try {
      const { audioBuffer } = await voicePipeline.getFirstMessageAudio({
        ...session.agent.toObject(),
        firstMessage: endMsg,
      });
      if (audioBuffer && audioBuffer.length > 0) {
        sendAudioBuffer(session, audioBuffer);
      }
    } catch (e) {}
  }

  // Call recording is disabled — no audio is written to disk and no
  // recordingUrl is stored on the call log.

  // Update call log
  const endTime = new Date();
  const duration = Math.round((endTime - new Date(session.startTime)) / 1000);

  if (session.callLogId) {
    await flushCallLogWriteQueue(session);
    const updateData = {
      status: 'completed',
      endTime,
      duration,
      endReason: reason,
    };

    const finalCallLog = await CallLog.findByIdAndUpdate(session.callLogId, updateData, { new: true });

    // Background analysis — fire-and-forget, but broken into focused helpers
    // (instead of one deep nested .then chain) so a failure in one stage
    // (memory / CRM / webhook / notifications) doesn't abort the others and
    // is logged with clear context.
    if (!session.skipPostCallAnalysis && finalCallLog && finalCallLog.transcript.length > 0) {
      runPostCallAnalysis(session).catch(err =>
        console.error('[PostCall] Background analysis error:', err.message)
      );
    }

    // Update agent stats
    if (session.agent) {
      await Agent.findByIdAndUpdate(session.agent._id, {
        $inc: { callsCount: 1, totalMinutes: Math.round(duration / 60) }
      });
    }
  }

  safeSend(session.ws, {
    type: 'session_ended',
    reason,
    duration,
    messageCount: session.history.length,
    callLogId: session.callLogId,
  });
}

/**
 * Post-call analysis orchestrator. Runs the LLM analysis once, persists it,
 * then fans out to memory / CRM / webhook / notifications. Each stage is
 * independently guarded so one failure never blocks the rest.
 */
async function runPostCallAnalysis(session) {
  const callLogId = session.callLogId;
  const finalCallLog = await CallLog.findById(callLogId);
  if (!finalCallLog || !finalCallLog.transcript?.length) return;

  const analysis = await voicePipeline.analyzeCall(finalCallLog.transcript, session.agent);
  if (!analysis) return;

  // 1. Persist analysis fields
  try {
    await CallLog.findByIdAndUpdate(callLogId, {
      summary: analysis.summary,
      sentiment: analysis.sentiment,
      emotion: analysis.emotion,
      metrics: analysis.metrics,
      actionItems: analysis.actionItems,
      extractedData: analysis.extractedData,
      topics: analysis.topics || [],
      decisions: analysis.decisions || [],
      customerIntent: analysis.customerIntent || '',
      urgencyLevel: analysis.urgencyLevel || '',
      followUpRequired: analysis.followUpRequired || false,
      qa: { score: analysis.qaScore || 0, grade: analysis.qaGrade || '' },
      tags: analysis.tags || [],
    });
  } catch (e) {
    console.error('[PostCall] Save analysis failed:', e.message);
  }

  // 2. Run the independent fan-out stages in parallel; isolate failures.
  await Promise.allSettled([
    saveUserMemory(session, analysis),
    upsertCrmLead(session, analysis),
    dispatchPostCallWebhook(session, analysis),
    sendPostCallNotifications(session, analysis),
  ]);

  console.log(`[Analysis Complete] Session: ${session.id}`);
}

/** Persist extracted facts to UserMemory ("pichli baatein"). */
async function saveUserMemory(session, analysis) {
  const ed = analysis.extractedData || {};
  if (Object.keys(ed).length === 0) return;
  try {
    const UserMemory = require('../models/UserMemory');
    const userPhone = session.callParams?.from || 'test_user';
    const newFacts = Object.entries(ed).map(([key, value]) => ({
      content: `${key}: ${value}`,
      category: 'extracted',
    }));
    if (newFacts.length > 0) {
      await UserMemory.findOneAndUpdate(
        { userId: session.userId, phone: userPhone },
        { $push: { facts: { $each: newFacts, $slice: -20 } } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      console.log(`[Memory Updated] User: ${userPhone}`);
    }
  } catch (err) {
    console.error('[PostCall] UserMemory save error:', err.message);
  }
}

/** Auto-create / update a CRM lead when name + phone were extracted. */
async function upsertCrmLead(session, analysis) {
  const ed = analysis.extractedData || {};
  const leadName = ed.name || '';
  const leadPhone = ed.phone || '';
  if (!leadName || !leadPhone) return;

  try {
    const Lead = require('../models/Lead');
    const existingLead = await Lead.findOne({ userId: session.userId, phone: leadPhone });

    if (!existingLead) {
      await Lead.create({
        userId: session.userId,
        agentId: session.agent?._id,
        callLogId: session.callLogId,
        name: leadName,
        phone: leadPhone,
        email: ed.email || '',
        interest: analysis.customerIntent || ed.company || '',
        status: 'Warm',
        value: '',
        notes: analysis.summary || '',
      });
      console.log(`[CRM] Lead auto-created: ${leadName} (${leadPhone})`);
    } else {
      await Lead.findByIdAndUpdate(existingLead._id, {
        $set: {
          notes: analysis.summary || existingLead.notes,
          ...(ed.email && { email: ed.email }),
          ...(ed.company && { interest: ed.company }),
        },
      });
      console.log(`[CRM] Lead updated: ${leadName} (${leadPhone})`);
    }
  } catch (err) {
    console.error('[CRM] Auto lead creation error:', err.message);
  }
}

/** Fire the post-call webhook + emit the Vapi-compatible call.ended event. */
async function dispatchPostCallWebhook(session, analysis) {
  try {
    const freshCallLog = await CallLog.findById(session.callLogId);
    if (!freshCallLog) return;

    webhookDispatcher.dispatch(freshCallLog, session.agent, session.userSettings)
      .catch(e => console.error('[Webhook Dispatch Error]', e.message));

    serverEvents.emit(session, 'call.ended', {
      duration: freshCallLog.duration,
      endReason: freshCallLog.endReason,
      summary: analysis.summary,
      sentiment: analysis.sentiment,
      emotion: analysis.emotion,
      topics: analysis.topics || [],
      customerIntent: analysis.customerIntent,
      urgencyLevel: analysis.urgencyLevel,
      followUpRequired: !!analysis.followUpRequired,
      actionItems: analysis.actionItems || [],
      extractedData: analysis.extractedData || {},
      qa: { score: analysis.qaScore, grade: analysis.qaGrade },
      tags: analysis.tags || [],
    });
  } catch (e) {
    console.error('[Webhook] Failed to load call log for dispatch:', e.message);
  }
}

/** Send SMS/WhatsApp post-call notifications if the agent enabled them. */
async function sendPostCallNotifications(session, analysis) {
  if (!session.agent?.postCallActions?.sendSMS && !session.agent?.postCallActions?.sendWhatsApp) return;
  try {
    const updatedCallLog = await CallLog.findById(session.callLogId);
    if (!updatedCallLog) return;
    const results = await notificationService.sendPostCallNotifications({
      callLog: updatedCallLog,
      agent: session.agent,
      userSettings: session.userSettings,
    });
    if (results && results.length > 0) {
      console.log(`[Notifications] Sent ${results.length} post-call notifications`);
    }
  } catch (err) {
    console.error('Post-call notification error:', err.message);
  }
}

async function cleanupSession(session) {
  // Cancel any in-flight LLM HTTP request so a dying call doesn't keep
  // burning Groq/Gemini quota (the 429 we saw in production logs came
  // from an idle-timer firing AFTER the WS had disconnected).
  if (session._currentAbortController) {
    try { session._currentAbortController.abort(); } catch (_) {}
    session._currentAbortController = null;
  }
  // Stop the idle re-engagement timer — without this it would still fire
  // 10s later and trigger processTranscript on a dead session.
  if (session._idleTimer)          { clearTimeout(session._idleTimer);          session._idleTimer = null; }
  if (session._silenceTimer)       { clearTimeout(session._silenceTimer);       session._silenceTimer = null; }
  if (session._agentSpeakingTimer) { clearTimeout(session._agentSpeakingTimer); session._agentSpeakingTimer = null; }
  if (session._dtmfFlushTimer)     { clearTimeout(session._dtmfFlushTimer);     session._dtmfFlushTimer = null; }
  if (session._softCommitTimer)    { clearTimeout(session._softCommitTimer);    session._softCommitTimer = null; }
  if (session._logFlushInterval)   { clearInterval(session._logFlushInterval);  session._logFlushInterval = null; }
  session._softCommitBuffer = '';

  // Flush any pending transcript writes BEFORE we close so the last few
  // turns don't get dropped on an abrupt disconnect.
  await flushCallLogWriteQueue(session).catch(() => {});

  if (session.deepgramConn) {
    try { session.deepgramConn.finish(); } catch (e) {}
    session.deepgramConn = null;
  }
  // Drop the cached rolling summary for this session so it doesn't leak.
  try { voicePipeline.clearSummaryCache(session.id); } catch (_) {}
  if (session.status !== 'ended') {
    await handleEndSession(session, 'connection_closed').catch(() => {});
  }
}

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(JSON.stringify(data));
    }
  } catch (e) {
    // Ignore send errors on closed connections
  }
}

/**
 * Allocate the next audio sequence number for the current generation.
 * Resets to 0 whenever the active generationId changes (interruption / new turn).
 * Frontend WorkletJitterAudioPlayer uses (generationId, seq) to:
 *   1. Detect a new turn and flush stale buffered audio
 *   2. Order chunks deterministically inside a turn
 */
function nextAudioSeq(session) {
  const gen = session.currentGenerationId || 'init';
  if (session._audioSeqGenerationId !== gen) {
    session._audioSeqGenerationId = gen;
    session._audioSeqCounter = 0;
  }
  const seq = session._audioSeqCounter || 0;
  session._audioSeqCounter = seq + 1;
  return { seq, generationId: gen };
}

/**
 * Wait until the WebSocket has drained below the soft cap. Uses a tight
 * event-driven check (poll bufferedAmount on a 30ms tick) instead of the
 * old 100ms blind sleep — that 100ms tick added 50-100ms of jitter to
 * every audio chunk send when buffers were below threshold.
 */
function waitForWsDrain(ws, maxBufferedBytes) {
  return new Promise((resolve) => {
    if (ws.readyState !== 1 || ws.bufferedAmount <= maxBufferedBytes) {
      resolve();
      return;
    }
    const tick = () => {
      if (ws.readyState !== 1 || ws.bufferedAmount <= maxBufferedBytes) {
        resolve();
        return;
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

/**
 * Send audio chunk WITHOUT audio_end — used for intermediate chunks (backchannels, mid-stream).
 * Does NOT reset agentSpeaking timer.
 */
function sendAudioChunkOnly(session, buffer) {
  // Call recording is disabled — we never write audio to disk.
  session.agentSpeaking = true;

  const { seq, generationId } = nextAudioSeq(session);
  const timestamp = Date.now();

  const task = async () => {
    const maxBufferedBytes = Number(process.env.WS_MAX_BUFFERED_BYTES || 2 * 1024 * 1024);
    await waitForWsDrain(session.ws, maxBufferedBytes);
    if (session.currentGenerationId !== generationId) {
      console.log(`[AudioQueue] Dropping stale audio chunk for generation ${generationId}`);
      return;
    }

    if (session.prefersBinaryAudio) {
      safeSendBinary(session.ws, buffer);
    } else {
      const base64Audio = buffer.toString('base64');
      if (session.streamProtocol) {
        safeSend(session.ws, { type: 'audio_stream', chunk: base64Audio, seq, generationId, timestamp });
      } else {
        safeSend(session.ws, { type: 'audio', data: base64Audio, seq, generationId, timestamp });
      }
    }
  };

  session._audioSendQueue = (session._audioSendQueue || Promise.resolve()).then(task).catch(console.error);
}

function sendAudioBuffer(session, buffer, isFinal = true) {
  // Call recording is disabled — we never write audio to disk.
  session.agentSpeaking = true;

  const { seq, generationId } = nextAudioSeq(session);
  const timestamp = Date.now();

  // Accumulate estimated audio duration for EVERY chunk (not just the final one).
  // MP3 at ~32kbps: bytes / 4000 ≈ seconds. This must happen synchronously here
  // (before the async task) so the timer gets the full total when isFinal fires.
  // Previously this was inside the isFinal block only — so streaming chunks
  // (isFinal=false) never accumulated, the timer was set to ~500ms regardless
  // of how many chunks were queued, and agentSpeaking cleared mid-sentence.
  if (buffer && buffer.length > 0) {
    if (!session._audioQueueDurationMs) session._audioQueueDurationMs = 0;
    const chunkDurationMs = Math.round((buffer.length / 4000) * 1000);
    session._audioQueueDurationMs += Math.max(200, chunkDurationMs);
  }

  const task = async () => {
    const maxBufferedBytes = Number(process.env.WS_MAX_BUFFERED_BYTES || 2 * 1024 * 1024);
    await waitForWsDrain(session.ws, maxBufferedBytes);
    if (session.currentGenerationId !== generationId) {
      console.log(`[AudioQueue] Dropping stale audio buffer for generation ${generationId}`);
      return;
    }

    // Skip sending empty buffers — they exist only to flush isFinal markers
    if (buffer && buffer.length > 0) {
      if (session.prefersBinaryAudio) {
        safeSendBinary(session.ws, buffer);
      } else {
        const base64Audio = buffer.toString('base64');
        if (session.streamProtocol) {
          safeSend(session.ws, { type: 'audio_stream', chunk: base64Audio, seq, generationId, timestamp });
        } else {
          safeSend(session.ws, { type: 'audio', data: base64Audio, seq, generationId, timestamp });
        }
      }
    }

    if (isFinal) {
      if (!session.latency.firstAudioAt) {
        session.latency.firstAudioAt = Date.now();
        emitLatencyMetrics(session, 'first_audio');
      }

      // lastSeq lets the player know there is no more audio coming for this generation
      // so it can drain its jitter buffer without waiting for a missing packet.
      const lastSeq = Math.max(0, (session._audioSeqCounter || 1) - 1);
      safeSend(session.ws, {
        type: session.streamProtocol ? 'audio_stream_end' : 'audio_end',
        generationId,
        lastSeq,
      });

      // Use the fully-accumulated duration (all chunks summed above) +
      // a 600ms tail buffer so the last word finishes before we start listening.
      const totalDuration = session._audioQueueDurationMs || 1000;
      if (session._agentSpeakingTimer) clearTimeout(session._agentSpeakingTimer);
      session._agentSpeakingTimer = setTimeout(() => {
        session.agentSpeaking = false;
        session._lastSttTranscript = '';
        startIdleTimer(session);
        session._audioQueueDurationMs = 0;
      }, totalDuration + 600);
    }
  };

  session._audioSendQueue = (session._audioSendQueue || Promise.resolve()).then(task).catch(console.error);
}


function safeSendBinary(ws, buffer) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(buffer, { binary: true });
    }
  } catch (e) {
    // Ignore send errors on closed connections
  }
}

function emitLatencyMetrics(session, stage = 'update') {
  const now = Date.now();
  const turnStartedAt = session.latency?.turnStartedAt;
  const llmStartedAt = session.latency?.llmStartedAt;
  const firstTextChunkAt = session.latency?.firstTextChunkAt;
  const firstAudioAt = session.latency?.firstAudioAt;

  if (!turnStartedAt) return;

  safeSend(session.ws, {
    type: 'latency_metrics',
    stage,
    traceId: session.traceId,
    turnId: session.currentGenerationId,
    timestamp: now,
    metrics: {
      stt_to_pipeline_ms: llmStartedAt ? Math.max(0, llmStartedAt - turnStartedAt) : null,
      stt_to_first_text_ms: firstTextChunkAt ? Math.max(0, firstTextChunkAt - turnStartedAt) : null,
      stt_to_first_audio_ms: firstAudioAt ? Math.max(0, firstAudioAt - turnStartedAt) : null,
      ws_buffered_amount: session.ws?.bufferedAmount || 0,
      dropped_audio_chunks: session.droppedAudioChunks || 0,
      transport: session.prefersBinaryAudio ? 'binary' : 'base64',
    },
  });
}

function queueCallLogUpdate(session, update, label = 'call_log_update') {
  if (!session?.callLogId) return;

  if (!session._pendingLogUpdates) {
    session._pendingLogUpdates = [];
  }
  
  if (update.$push && update.$push.transcript) {
    session._pendingLogUpdates.push(update.$push.transcript);
  } else {
    // Non-transcript updates (like metrics/flags) happen immediately
    CallLog.findByIdAndUpdate(session.callLogId, update).catch(() => {});
    return;
  }

  // Setup flush interval (runs every 5 seconds to bulk write)
  if (!session._logFlushInterval) {
    session._logFlushInterval = setInterval(() => {
       flushCallLogWriteQueue(session);
    }, 5000);
  }
}

async function flushCallLogWriteQueue(session) {
  if (!session?.callLogId || !session._pendingLogUpdates || session._pendingLogUpdates.length === 0) return;
  
  const transcriptsToPush = [...session._pendingLogUpdates];
  session._pendingLogUpdates = [];

  try {
     await CallLog.findByIdAndUpdate(session.callLogId, {
        $push: { transcript: { $each: transcriptsToPush } }
     });
  } catch (err) {
     console.error(`[CallLog Bulk Update Error]:`, err.message);
     // Put them back at the front of the queue to retry next interval
     session._pendingLogUpdates = [...transcriptsToPush, ...(session._pendingLogUpdates || [])];
  }
}

function allowAudioIngress(session, chunkBytes) {
  const maxChunkBytes = Number(process.env.MAX_AUDIO_CHUNK_BYTES || 256 * 1024);
  const maxBytesPerSecond = Number(process.env.MAX_AUDIO_BYTES_PER_SECOND || 512 * 1024);
  const now = Date.now();

  if (chunkBytes > maxChunkBytes) {
    session.droppedAudioChunks += 1;
    console.warn(`[AudioIngress] Dropped oversized audio chunk: ${chunkBytes} bytes > ${maxChunkBytes} bytes (session=${session.id})`);
    return false;
  }

  if (now - session.audioIngressWindowStartedAt >= 1000) {
    session.audioIngressWindowStartedAt = now;
    session.audioIngressBytesInWindow = 0;
  }

  if (session.audioIngressBytesInWindow + chunkBytes > maxBytesPerSecond) {
    session.droppedAudioChunks += 1;
    if (session.droppedAudioChunks % 20 === 1) {
      console.warn(`[AudioIngress] Rate limited audio: window=${session.audioIngressBytesInWindow} + chunk=${chunkBytes} > ${maxBytesPerSecond} bytes/s (session=${session.id})`);
      safeSend(session.ws, {
        type: 'status',
        message: 'Audio rate limited briefly to keep call stable.',
      });
    }
    return false;
  }

  session.audioIngressBytesInWindow += chunkBytes;
  return true;
}

function trySttFallbackReconnect(session, deepgramKey) {
  if (!session?.agent || !session?.ws) return;
  if (session.sttRetryAttempted) return;

  const fallbackLanguage = process.env.STT_FALLBACK_LANGUAGE || 'multi';
  const currentLanguage = session.agent.language || 'en';

  // Always allow fallback if current language is problematic
  if (currentLanguage === fallbackLanguage && currentLanguage !== 'hi') return;

  session.sttRetryAttempted = true;
  session.sttUnavailable = false;

  try {
    if (session.deepgramConn) {
      try { session.deepgramConn.finish(); } catch (_) {}
    }
  } catch (_) {}

  console.log(`[STT Fallback] Retrying with language: ${fallbackLanguage} (was: ${currentLanguage})`);

  safeSend(session.ws, {
    type: 'status',
    message: `🔄 Retrying STT with fallback language (${fallbackLanguage}) for better compatibility...`,
  });

  // Use shared helper so the fallback path retains all smart features
  // (interruption, backchanneling, silence-timer, idle re-engagement).
  // isReconnect=true prevents recursive fallback if this attempt also fails.
  session.deepgramConn = createSessionDeepgramConn(session, {
    deepgramKey,
    language: fallbackLanguage,
    audioConfig: session._lastAudioConfig || null,
    isReconnect: true,
  });
}

module.exports = { setupVoiceSession, canAcceptNewSession, getActiveSessionCount };
