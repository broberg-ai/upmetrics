# F007 — Ops Hardening (Retention & Rate Limiting)

> Tier: medium · Effort: S (Uge 10) · Status: planned

## Motivation

A single-binary bun:sqlite-on-volume deployment is cheap and simple but vulnerable to two failure modes in PLAN §11's risk table: a buggy client's runaway ingest filling the DB, and unbounded storage growth. F17 (retention/compaction) and F18 (rate limiting/quotas) are the guardrails that keep the deployment healthy without adding infrastructure.

## Solution

A daily compaction job that enforces per-project retention and downsamples old probe history, plus per-project ingest rate limits and storage caps that drop-with-warning rather than crash.

## Scope

### In scope
- **F17 Retention & compaction:** per-project `retention_days` (default 30); daily job deletes `events` past retention; `probe_results` compacted to hourly aggregates after 7 days; `agent_runs` retention independently (longer) configurable.
- **F18 Rate limiting & quotas:** per-project ingest rate limit (events/minute); per-project storage cap; exceeding cap drops new data with a single warning event; all configurable per project.

### Out of scope
- Dead-man's-switch (F004 owns it).
- Any new storage backend (ClickHouse/Loki are Phase 2 — explicitly out).
- Dashboard surfacing of quota state (nice-to-have; F006 can add a badge later).

## Architecture (PLAN §5, §11)

### Compaction (F17)
Daily background job (Hono `setInterval` or a cronjobs-scheduled call). Deletes expired `events`; rolls `probe_results` older than 7 days into hourly aggregates; respects per-project `retention_days`. Batched deletes to avoid long DB locks against live ingest.

### Rate limiting + quotas (F18)
Per-project counters (events/minute) checked at ingest; per-project storage cap checked periodically. Over-limit → drop new data + emit ONE warning event (no spam, no crash). Limits read from `projects` config columns.

## Stories
- **F007.1** — Retention + daily compaction job (events purge, probe_results hourly downsample, agent_runs separate retention).
- **F007.2** — Per-project ingest rate limiting + storage cap with drop-with-warning.

## Acceptance criteria
1. Daily compaction deletes events past `retention_days` and downsamples probe_results to hourly after 7 days; agent_runs retention independently configurable.
2. Per-project ingest rate limit enforced; bursts rejected without crashing ingest.
3. Storage cap drops new data with a single warning event when exceeded (no silent loss, no crash).
4. All limits read from project config, not hardcoded; changes take effect without redeploy.
5. Compaction runs without locking out live ingest for a noticeable window.

## Dependencies
- **F001** (schema + `projects` config columns: `retention_days`, quota fields).
- **F002** (events to retain/limit), **F004** (probe_results to compact).

## Rollout
Single-phase, Uge 10. Ship retention first (immediate storage relief), then rate limiting. Both are background/middleware concerns — no UI dependency. Rollback = disable the job / raise limits via config.

## Open Questions
- None blocking. Default thresholds (events/minute, storage cap) can be tuned per project after first real load.

## Effort estimate
**S** — ~Uge 10 in PLAN §12 (alongside deploy + migration).
