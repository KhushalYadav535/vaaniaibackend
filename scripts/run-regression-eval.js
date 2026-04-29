/**
 * Day 12 regression harness for voice runtime.
 *
 * Usage:
 *   EVAL_TOKEN=... EVAL_AGENT_ID=... node scripts/run-regression-eval.js
 */
require('dotenv').config();
const WebSocket = require('ws');

const WS_URL = process.env.EVAL_WS_URL || `ws://localhost:${process.env.PORT || 5000}/ws/voice`;
const TOKEN = process.env.EVAL_TOKEN || '';
const AGENT_ID = process.env.EVAL_AGENT_ID || '';
const LATENCY_BUDGET_MS = Number(process.env.EVAL_MAX_STT_TO_FIRST_AUDIO_MS || 2000);
const OUTPUT_JSON = String(process.env.EVAL_OUTPUT_JSON || 'true').toLowerCase() === 'true';

const SCENARIOS = [
  'Hello, can you quickly tell me what services you provide?',
  'Mujhe Hindi mein short answer do: main account support kaise paun?',
  'Please summarize in one sentence what you can help me with.',
];

function nowMs() {
  return Date.now();
}

async function runSingleScenario(text) {
  return new Promise((resolve) => {
    const startedAt = nowMs();
    let firstResponseText = '';
    let firstAudioLatency = null;
    let closed = false;
    let promptSent = false;

    const ws = new WebSocket(WS_URL);

    const finalize = (result) => {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch (_) {}
      resolve(result);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'init',
        token: TOKEN,
        agentId: AGENT_ID,
        preferBinaryAudio: true,
        enableStt: false,
        skipPostCallAnalysis: true,
      }));
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        const textPayload = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        msg = JSON.parse(textPayload);
      } catch (_) {
        return;
      }

      if (msg.type === 'ready') {
        ws.send(JSON.stringify({ type: 'text', text }));
        promptSent = true;
      }

      if (
        promptSent &&
        !firstResponseText &&
        (msg.type === 'response_text_chunk' || msg.type === 'response_text') &&
        msg.text &&
        !msg.isFirstMessage
      ) {
        firstResponseText = msg.text;
      }

      if (msg.type === 'latency_metrics' && msg.metrics?.stt_to_first_audio_ms != null) {
        firstAudioLatency = msg.metrics.stt_to_first_audio_ms;
        finalize({
          text,
          ok: firstAudioLatency <= LATENCY_BUDGET_MS && !!firstResponseText,
          firstAudioLatencyMs: firstAudioLatency,
          firstResponseText,
          elapsedMs: nowMs() - startedAt,
        });
      }

      if (msg.type === 'error') {
        finalize({
          text,
          ok: false,
          firstAudioLatencyMs: null,
          firstResponseText,
          elapsedMs: nowMs() - startedAt,
          error: msg.message || 'unknown_error',
        });
      }
    });

    ws.on('error', (err) => {
      finalize({
        text,
        ok: false,
        firstAudioLatencyMs: firstAudioLatency,
        firstResponseText,
        elapsedMs: nowMs() - startedAt,
        error: err.message,
      });
    });

    setTimeout(() => {
      finalize({
        text,
        ok: false,
        firstAudioLatencyMs: firstAudioLatency,
        firstResponseText,
        elapsedMs: nowMs() - startedAt,
        error: 'scenario_timeout',
      });
    }, Number(process.env.EVAL_SCENARIO_TIMEOUT_MS || 15000));
  });
}

async function main() {
  if (!TOKEN || !AGENT_ID) {
    console.error('Missing EVAL_TOKEN or EVAL_AGENT_ID');
    process.exit(1);
  }

  const results = [];
  for (const scenario of SCENARIOS) {
    /* eslint-disable no-await-in-loop */
    const result = await runSingleScenario(scenario);
    results.push(result);
  }

  const passed = results.filter(r => r.ok).length;
  const summary = {
    wsUrl: WS_URL,
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: Number(((passed / results.length) * 100).toFixed(1)),
    latencyBudgetMs: LATENCY_BUDGET_MS,
    results,
  };

  if (OUTPUT_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Regression pass rate: ${summary.passRate}% (${passed}/${results.length})`);
    results.forEach((r, i) => {
      console.log(`#${i + 1}`, r.ok ? 'PASS' : 'FAIL', `latency=${r.firstAudioLatencyMs}`, r.error || '');
    });
  }

  process.exit(summary.failed > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
