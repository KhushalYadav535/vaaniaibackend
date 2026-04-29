# Day 14 Release Checklist

## Pre-release
- [ ] Backend restarted with updated `.env` values.
- [ ] `FAST_TURN_MODE` validated in logs.
- [ ] Binary audio transport verified in `test-agent` and `widget`.
- [ ] No linter/runtime errors in modified files.

## Observability
- [ ] `x-request-id` header visible on HTTP responses.
- [ ] `latency_metrics` events include `traceId`, transport, dropped chunks, buffered amount.
- [ ] Baseline p50/p95 captured for `stt_to_first_audio_ms`.

## Regression (Day 12 harness)
- [ ] Run `npm run eval:regression`.
- [ ] Pass rate >= 90%.
- [ ] No scenario timeout for happy-path prompts.

## Load smoke (Day 14 harness)
- [ ] Run `npm run load:smoke`.
- [ ] Success rate >= 95% for configured concurrency.
- [ ] p95 latency within target envelope.

## Security checks (Day 13)
- [ ] `SUPER_ADMIN_WRITE_ENABLED` explicitly set for production intent.
- [ ] Production does not use default `JWT_SECRET`.
- [ ] Super-admin write routes blocked when flag is disabled.

## Go/No-Go
- [ ] If any KPI fails, rollback to previous stable env profile.
- [ ] If all KPIs pass, tag release and monitor first 30 minutes.
