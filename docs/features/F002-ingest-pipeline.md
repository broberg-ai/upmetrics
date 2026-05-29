# F002 — Ingest Pipeline

> Tier: critical · Effort: M (Uge 2) · Status: planned

## Motivation

Upmetrics is useless until it can receive data. The plan's whole value prop — "point any Sentry SDK at us" + first-class agent monitoring — lives in the write-path: a Sentry-compatible envelope endpoint, error grouping into deduplicated issues, and an agent-run ingest endpoint. Without this, there are no events, no issues, no agent runs.

## Solution

Implement a strict subset of the Sentry envelope protocol at `POST /api/{project_id}/envelope/`, a fingerprint-based grouping worker that maps events to `issues`, and `POST /api/agent` for agent-run lifecycle (start/finish/record). Grouping runs async so ingest never blocks the caller.

## Scope

### In scope
- **F02 Envelope ingest:** parse newline-delimited envelope, validate against project DSN, persist as `events`, hand off to grouping async (PLAN §7).
- **F03 Error grouping:** fingerprint = hash(exception.type + normalized top frame); match-or-create `issues`; update `last_seen`/`event_count`/`user_count`; reopen if previously resolved.
- **F04 Agent run ingest:** `POST /api/agent` with modes `start` (create run, status=running, return run_id), `finish` (final state), and single-shot `record`; authed by `X-Upmetrics-Key`.
- `docs/ENVELOPE-SPEC.md` + `docs/AGENT-SCHEMA.md`.

### Out of scope
- Probe-result ingest (F004).
- SDKs that produce these payloads (F003) — this epic is server-side only; test with curl/@sentry/cli.
- Any dashboard rendering of issues/agents (F006).
- Incident correlation / alerting on the ingested data (F005).

## Architecture

### Envelope endpoint (PLAN §7)
`POST /api/{project_id}/envelope/`. Auth via DSN public key in `X-Sentry-Auth` or query. Item types: `event` full; `transaction` stored-not-displayed; `attachment`+`session` dropped; `check_in` stored. Persist to `events`, enqueue grouping.

### Grouping worker
In-process async (Hono `setInterval` or post-insert hook). Computes fingerprint, upserts `issues`, links `events.issue_id`, reopens resolved issues.

### Agent ingest
`POST /api/agent` authed by per-project `api_key`. Writes `agent_runs` (schema from F001). `start`→running+run_id; `finish`→duration/status/tokens/cost; `record`→one-shot completed.

## Stories
- **F002.1** — Envelope parser + endpoint + DSN validation + persist events.
- **F002.2** — Error grouping worker (fingerprint, issue upsert, reopen).
- **F002.3** — Agent-run ingest endpoint (start/finish/record).
- **F002.4** — ENVELOPE-SPEC.md + AGENT-SCHEMA.md.

## Acceptance criteria
1. `npx @sentry/cli send-event` against the endpoint creates an event + issue.
2. Two events with the same exception type+frame group into one issue (event_count=2); a resolved issue reopens on a new matching event.
3. `POST /api/agent` start→finish lifecycle persists a complete `agent_runs` row; bad API key is rejected 401.
4. Unsupported item types handled per spec without failing the envelope.
5. ENVELOPE-SPEC.md + AGENT-SCHEMA.md committed and match the implementation.

## Dependencies
- **F001** (schema: `events`, `issues`, `agent_runs`, `projects`).

## Rollout
Single-phase, server-side. Verify with curl + @sentry/cli payloads before SDKs (F003) exist. Dogfood by pointing upmetrics' own server errors at itself once F003 lands.

## Open Questions
- None blocking. Fingerprint normalization rules can be tuned iteratively without schema change.

## Effort estimate
**M** — ~1 week (Uge 2 in PLAN §12).
