# F010 — Closed-loop auto-remediation relay (upmetrics → Buddy → responsible cc session)

> Tier: high · Effort: M · Status: planned · Proposed 2026-05-31

## Motivation

After the fleet rollout, every WebHouse site/app reports errors into upmetrics (FysioDK, CMS, sanneandersen live; trail/xrt81/cardmem in progress). Detection without action is half the value. Christian's idea: **close the loop** — when a real error fires, relay it *in-the-loop via Buddy* to the **responsible repo's cc session**, which fixes the root cause and deploys. upmetrics already has the dispatch primitive (F005.3 remediation dispatcher: HMAC-signed webhook, 3× retry); Buddy already has cross-session messaging (`ask_peer`/`announce`) and a session registry. F010 wires them into a closed loop.

```
SDK error → upmetrics ingest → grouping/incident (F005.1)
   → remediation relay (F010) → Buddy → responsible cc session (repo)
   → cc fixes root cause + deploys → new release
   → upmetrics: issue stays resolved, OR auto-reopens on regression → re-relay
```

## Scope

### In scope
- **`buddy` remediation target** (extends F005.3): on a qualifying error issue, POST a structured, PII-scrubbed remediation request to Buddy's intercom API for the responsible repo.
- **Project → repo → session routing**: map each upmetrics project to its repo and the active cc session (via Buddy's session registry / `discoverChannels`). No active session → fall back to a queue/Discord ping, never drop.
- **Opt-in + thresholds**: per-project `remediation_relay` on/off + min severity / min occurrences before relaying. Dedup to one open relay per issue.
- **Storm-control awareness** (F008.3): suppress relays during a fleet/region outage; respect the global rate-limit; collapse overflow into a digest.
- **Closed-loop confirmation**: regression detection — an issue resolved in release X auto-reopens if it recurs in a newer release, re-triggering the relay. Record relay attempts on the issue (who, when, reply).
- **cc-side convention**: the standard shape of an upmetrics remediation message (project, title, culprit, stack frames, release, occurrences, dashboard link) and the expected reply (fixed in commit/release, or needs-human) that upmetrics records.

### Out of scope / non-goals
- Auto-merging/auto-deploying customer sites without the configured policy — F010 relays + (optionally) gates on approval; the cc session + its repo rules own the actual fix/deploy.
- Replacing F005.3's generic HMAC webhook (kept for non-Buddy targets).
- LLM root-cause analysis inside upmetrics — the cc session does the reasoning; upmetrics supplies clean context.

## Architecture sketch

- **Trigger**: F005.1 opens/updates an incident for an error issue. F010 evaluates relay eligibility (opt-in, severity≥threshold, occurrences≥threshold, not storm-suppressed, not already relayed in-window).
- **Payload** (scrubbed via the SDK scrubber): `{ project, repo, issue_id, title, culprit, level, release, environment, first_seen, event_count, top_stack_frames[], dashboard_url }`.
- **Routing**: `project → repo` (config/table) and `repo → active session` (Buddy registry). Deliver via Buddy intercom (`ask_peer` to the session) — or a fallback channel if no session is live.
- **Relay store**: record on the issue (or a `remediation_relays` table) — relayed_at, target_session, status (sent|acked|fixed|failed), reply. Powers dedup + the dashboard's incident view.
- **Confirmation**: grouping stamps `resolved_in_release`; a later event in a newer release reopens the issue (regression) and re-relays. A genuinely-fixed issue receives no new events → stays resolved.

## Stories
- **F010.1** — `buddy` remediation target: eligibility check + scrubbed payload + POST to Buddy intercom for the responsible repo (extends F005.3 dispatcher).
- **F010.2** — Project→repo→session routing + per-project opt-in/threshold config + fallback when no session is active.
- **F010.3** — Closed-loop: relay dedup (one open per issue), storm-control suppression, regression reopen, and recording relay attempts/replies on the issue.
- **F010.4** *(optional)* — cc-side convention doc + a tiny helper so a session can reply a structured remediation result upmetrics records.

## Acceptance criteria (epic-level)
1. A qualifying error issue for an opted-in project relays exactly ONE structured, PII-scrubbed remediation request to the responsible repo's active cc session via Buddy (title, culprit, stack, release, occurrences, dashboard link).
2. Routing resolves project→repo→active session; with no active session it falls back (queue/Discord), never drops.
3. Relays respect F008.3 storm-control (no relay storm during a fleet outage) + the per-project opt-in + severity/occurrence threshold; dedup to one open relay per issue.
4. An issue resolved in release X auto-reopens and re-relays if the same error recurs in a newer release (regression); a fixed-and-quiet issue stays resolved. Relay attempts + replies are recorded on the issue.

## Dependencies
- **F005** (incident correlation + remediation dispatcher — F010 extends F005.3).
- **F008.3** (storm-control — relays must be suppressed/rate-limited the same way).
- **Buddy intercom** (`ask_peer`/`announce` + session registry / `discoverChannels`).
- **Fleet instrumentation** (this session's SDK rollout — errors must actually flow in per project).

## Rollout (phased)
1. F010.1 + F010.2 behind a per-project `remediation_relay` flag, default OFF; enable first on a broberg-owned repo (e.g. cardmem) to dogfood the loop end-to-end.
2. F010.3 (dedup + storm + regression) before enabling on customer-facing projects.
3. F010.4 convention doc so every cc session handles upmetrics remediation messages consistently.

## Open questions
- Approval gate: fully autonomous fix+deploy, or Christian-approves-first per project? Likely per-project policy (auto for broberg-owned, approve for customer sites).
- Where does project→repo→session mapping live — upmetrics `projects` columns, or queried from Buddy's registry at relay time? Lean on Buddy's live registry with a static project→repo map in upmetrics.
- Re-relay cadence for an un-acked relay (escalation) — tie to F008.3's rate-limit + a max-attempts cap.
