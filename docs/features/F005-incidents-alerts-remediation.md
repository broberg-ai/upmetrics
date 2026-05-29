# F005 — Incidents, Alerts & Remediation

> Tier: high · Effort: M (Uge 8–9) · Status: planned

## Motivation

Raw signals (a down probe, an error spike, an agent-failure spike) are noise until they're correlated into incidents, alerted on without spamming, and — optionally — handed to an external remediator. The plan is explicit that upmetrics stays small and safe by **calling webhooks, never running code itself** (§9). This epic turns signals into actionable, deduplicated incidents and routes them out.

## Solution

A correlation worker that groups signals into `incidents` with dynamic severity; an alert engine that evaluates rules and delivers via Resend/Discord/webhook with per-rule dedup; and a remediation dispatcher that POSTs a signed payload (incident + recent context) to a per-project URL, with retries and callback logging.

## Scope

### In scope
- **F08 Incident correlation:** background worker (~30s) merging probe_down + error_spike on same project, agent_failure_spike + recent deploy; dynamic severity (PLAN §5 `incidents`).
- **F09 Alert engine:** rule evaluator on incident open/escalate; channels Resend email, Discord webhook, generic webhook; per-rule dedup window; `alert_rules`/`alert_history`.
- **F10 Remediation dispatcher:** on incident open >= threshold with configured URL, build payload (incident + last N events + last N agent_runs), POST with HMAC + `remediation_token`, retry 3x backoff, log to `incidents.remediation_attempts`; accept `/api/incidents/{id}/remediation-callback`.
- `docs/REMEDIATION.md`.

### Out of scope
- Opening the raw `probe_down` incident (F004 does that); this epic correlates/escalates/alerts on incidents.
- Incident dashboard UI (F006).
- The receivers themselves (cardmem dispatch, app self-heal) live in their own repos.

## Architecture (PLAN §9)

### Correlation (F08)
Periodic worker reads recent signals, groups by project+time window, upserts `incidents`, adjusts severity.

### Alerts (F09)
On incident open/escalate, evaluate `alert_rules`; send via configured channels; record `alert_history`; dedup per rule window.

### Remediation (F10)
Decoupled: build payload, sign HMAC, POST to project `remediation_webhook_url`, 3x retry w/ backoff, log attempts. Receiver may callback with status. upmetrics executes nothing itself.

## Stories
- **F005.1** — Incident correlation worker + dynamic severity.
- **F005.2** — Alert engine (Resend/Discord/webhook) + per-rule dedup.
- **F005.3** — Remediation dispatcher (HMAC, retry, attempts log) + callback endpoint + REMEDIATION.md.
- **F005.4** — cardmem as a remediation target (integration verification).

## Acceptance criteria
1. probe_down + recent error_spike on one project correlate into a single incident with dynamic severity.
2. Alert rules deliver to email/Discord/webhook with per-rule dedup (no duplicate inside window).
3. Incident open above threshold POSTs a HMAC-signed remediation webhook with context.
4. Remediation retries 3x with backoff; every attempt+response logged to `incidents.remediation_attempts`.
5. `/api/incidents/{id}/remediation-callback` logs status to the timeline; REMEDIATION.md committed.

## Dependencies
- **F001** (schema: `incidents`, `alert_rules`, `alert_history`).
- **F002** (events/issues feed error_spike + context).
- **F004** (probe_down incidents feed correlation).

## Rollout
Correlation → alerts → remediation, in that order. Verify with a simulated incident before wiring cardmem as a real remediation target.

## Open Questions
- Single remediation URL per project confirmed for Phase 1 (PLAN §13.4) — routing deferred to receiver. No open blocker.

## Effort estimate
**M** — Uge 8–9 in PLAN §12.
