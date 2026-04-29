/**
 * Day 14 load smoke test for text-mode voice sessions.
 *
 * Usage:
 *   EVAL_TOKEN=... EVAL_AGENT_ID=... node scripts/run-load-smoke.js
 */
require('dotenv').config();
const WebSocket = require('ws');

const WS_URL = process.env.EVAL_WS_URL || `ws://localhost:${process.env.PORT || 5000}/ws/voice`;
const TOKEN = process.env.EVAL_TOKEN || '';
const AGENT_ID = process.env.EVAL_AGENT_ID || '';
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY || 10);
const TEST_TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS || 25000);

function runWorker(id) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let done = false;
    let firstAudioLatency = null;
    const ws = new WebSocket(WS_URL);

    const finish = (result) => {
      if (done) return;
      done = true;
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
        ws.send(JSON.stringify({ type: 'text', text: `Load test ping from worker ${id}` }));
      }

      if (msg.type === 'latency_metrics' && msg.metrics?.stt_to_first_audio_ms != null) {
        firstAudioLatency = msg.metrics.stt_to_first_audio_ms;
        finish({
          ok: true,
          latencyMs: firstAudioLatency,
          elapsedMs: Date.now() - startedAt,
        });
      }

      if (msg.type === 'error') {
        finish({
          ok: false,
          latencyMs: firstAudioLatency,
          elapsedMs: Date.now() - startedAt,
          error: msg.message || 'worker_error',
        });
      }
    });

    ws.on('error', (err) => {
      finish({
        ok: false,
        latencyMs: firstAudioLatency,
        elapsedMs: Date.now() - startedAt,
        error: err.message,
      });
    });

    setTimeout(() => {
      finish({
        ok: false,
        latencyMs: firstAudioLatency,
        elapsedMs: Date.now() - startedAt,
        error: 'timeout',
      });
    }, TEST_TIMEOUT_MS);
  });
}

async function main() {
  if (!TOKEN || !AGENT_ID) {
    console.error('Missing EVAL_TOKEN or EVAL_AGENT_ID');
    process.exit(1);
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => runWorker(i + 1));
  const results = await Promise.all(workers);
  const success = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const latencies = success.map(s => s.latencyMs).sort((a, b) => a - b);

  const percentile = (p) => {
    if (latencies.length === 0) return null;
    const idx = Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length));
    return latencies[idx];
  };

  const summary = {
    concurrency: CONCURRENCY,
    total: results.length,
    success: success.length,
    failed: fail.length,
    successRate: Number(((success.length / results.length) * 100).toFixed(1)),
    p50LatencyMs: percentile(50),
    p95LatencyMs: percentile(95),
    errors: fail.map(f => f.error || 'unknown'),
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.failed > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
