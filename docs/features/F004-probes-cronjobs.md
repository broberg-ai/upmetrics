# F004 — Probes & cronjobs Integration

> Tier: high · Effort: M (Uge 4 + Uge 8/9) · Status: planned

## Motivation

Half of upmetrics' value is uptime monitoring (replacing UptimeRobot). The plan deliberately reuses `cronjobs.webhouse.net` as the probe executor rather than building a new scheduler. Upmetrics defines probes and ingests results; cronjobs does the actual HTTP/TCP/SSL checks on a schedule. The dead-man's-switch closes the "who watches the watcher" gap.

## Solution

Probe CRUD in upmetrics that syncs each probe to a cronjobs.webhouse.net job; an HMAC-signed result-ingest endpoint that updates probe status and opens `probe_down` incidents; and an external heartbeat (dead-man's-switch) routed through cronjobs to a separate Discord channel.

## Scope

### In scope
- **F06 Probe definition + sync:** define probes (http/tcp/keyword/ssl) in upmetrics; on save call cronjobs API to create/update a job that runs the check and POSTs the result back. Status sync.
- **F07 Probe result ingest:** `POST /api/probe-result/{probe_id}`, HMAC-verified; persist `probe_results`; update `probe.status` from `consecutive_failures`; open `probe_down` incidents past threshold.
- **F19 Dead-man's-switch:** cronjobs pings upmetrics every 5 min; 2 consecutive misses → Discord alert on a separate channel.
- Small addition to cronjobs codebase if a 'scheduled HTTP probe' job-type doesn't already exist (PLAN §10).

### Out of scope
- The Probes dashboard UI (F006).
- Incident correlation beyond opening a raw probe_down (F005 owns correlation/severity).
- Alert delivery for incidents (F005 owns alert engine; this epic only OPENS the incident).

## Architecture (PLAN §10)

### Sync (upmetrics → cronjobs)
On probe save: `POST/PATCH/DELETE` cronjobs `/api/jobs` with Bearer token. Job target = check; job action = POST result to `/api/probe-result/{probe_id}`. Store `cronjobs_job_id` on the probe.

### Result ingest (cronjobs → upmetrics)
`POST /api/probe-result/{probe_id}` with HMAC signature. Persist `probe_results`, bump/reset `consecutive_failures`, set `probe.status` (up/down/degraded), open `incidents(kind=probe_down)` past threshold.

### Dead-man's-switch (F19)
cronjobs hits an upmetrics heartbeat every 5 min and tracks misses itself; 2 misses → Discord on a dedicated channel. Independent of upmetrics being up.

## Stories
- **F004.1** — Probe model API + cronjobs job sync (create/update/delete).
- **F004.2** — Probe-result ingest endpoint (HMAC, status, probe_down incident).
- **F004.3** — cronjobs 'scheduled HTTP probe' job-type (if missing) + auth wiring.
- **F004.4** — Dead-man's-switch heartbeat + separate Discord channel.

## Acceptance criteria
1. Creating/deleting a probe creates/removes the corresponding cronjobs job.
2. `POST /api/probe-result/{id}` verifies HMAC, persists, updates status from consecutive_failures.
3. Threshold breach opens a `probe_down` incident.
4. 10+ real probes run end-to-end against WebHouse sites.
5. Stopping upmetrics 10 min triggers a Discord alert via cronjobs on a separate channel.

## Dependencies
- **F001** (schema: `probes`, `probe_results`, `incidents`).
- **cronjobs.webhouse.net** (external repo) — job API + possible new job-type.
- Incident *delivery* (alerts) is **F005**; this epic only opens incidents.

## Rollout
Build probe sync + ingest first; verify with a couple of real probes; then scale to 10+. Dead-man's-switch last. cronjobs-side change shipped in its own repo/PR.

## Open Questions
- Does cronjobs already expose a generic 'scheduled HTTP request' job-type, or must we add one? (PLAN §10 — confirm against cronjobs codebase.)

## Effort estimate
**M** — Uge 4 (probes) + parts of Uge 8/9 (incidents wiring, dead-man).
