# F008 — Production resilience & scale

> Tier: high · Effort: M–L (phased) · Status: planned

## Motivation

On 2026-05-30 a real fly **emergency host-maintenance** in `arn` took upmetrics fully down: it runs as a **single `bun:sqlite`-on-volume machine**, so when the host went unreachable the whole service (and its DB) was gone — and we discovered the volume had **no snapshots**. At the same time the goal is to embed the `@upmetrics/sdk` in **every** WebHouse site/app. That raises three concerns Christian named explicitly:

1. Should it run on **multiple machines in multiple regions**, and how is that managed?
2. Does a **Cloudflare proxy** belong in front?
3. With many sites, a single large outage could fire **hundreds of Discord messages**.

There is also a sharp dependency bug: the dead-man's-switch (F004.4) runs on **cronjobs, which is ALSO on fly/arn**. A full `arn` outage takes down both upmetrics *and* its watchdog — so the one alert that matters most ("the region/upmetrics is down") may never fire.

## Reframe: this is two problems, not one

- **(A) upmetrics' own availability + durability** — real, but not the most urgent dollar.
- **(B) fleet-scale alert-storm control** — the sharp, cheap, urgent win.

**Ordering principle:** durability + storm-control + an external watchdog come *before* multi-region HA. An HA service that floods Discord is worse than a single-region one that alerts cleanly.

## The storage fork (why HA is a storage decision)

`bun:sqlite` on a fly volume is **single-writer**: a volume attaches to exactly one machine. "Run 3 machines" is therefore blocked by the *storage* choice, not by fly. Three tiers:

| Tier | What | Gives | Cost |
|---|---|---|---|
| **0 (now)** | Litestream → Tigris/S3 + daily fly volume snapshots | No data loss; restore to a fresh machine in minutes | Low, ~drop-in |
| **1** | LiteFS (fly-native distributed sqlite) | Primary + replicas, multi-region reads, auto-failover on machine loss | Medium ops (writes still funnel to primary) |
| **2** | Turso (managed libSQL) or Postgres/Supabase | True multi-region, managed | Near drop-in from our Drizzle/sqlite (Turso *is* sqlite) |

When there is >1 machine, **fly's own anycast proxy load-balances** — no Cloudflare needed for that. Cloudflare's real value is WAF/DDoS and a possible **edge-buffer for ingest** (a Worker + Queue that accepts events even when origin is down and replays them) — a later, optional build.

## Scope

### In scope
- **Durability (Tier 0):** Litestream continuous replication of the sqlite DB to Tigris (S3-compatible, arn) + enable daily fly volume snapshots with retention; documented restore runbook.
- **External watchdog:** an **off-fly** uptime check (Cloudflare Worker cron) that pings upmetrics + cronjobs and alerts (Discord) when the whole arn region/service is unreachable — independent of fly.
- **Fleet-scale alert-storm control** (extends F005's alert engine): mass-outage roll-up (N services down in a window → ONE alert with a count), dependency-aware suppression (region/upmetrics down → suppress per-site downstream noise), maintenance windows (silence known maintenance), global alert rate-limit/digest.
- **Storage-HA decision:** a spike + ADR choosing Turso (libSQL) vs LiteFS, with a migration plan from `bun:sqlite`.
- **Multi-region runtime:** once storage supports it, run 2+ machines (across regions) behind fly's anycast proxy.
- **(Optional) Cloudflare edge-buffer ingest:** Worker + Queue receives events when origin is down, replays on recovery.

### Out of scope / non-goals
- Five-nines / payments-grade HA — this is internal observability; short-outage telemetry loss is acceptable.
- Re-implementing F005.2 per-rule dedup — F008.3 builds *on top* of it (fleet-wide), not instead.
- Per-project ingest rate-limiting + storage quota — that is **F007.2**.
- Dashboard UI for incidents/maintenance — that is **F006**.

## Architecture sketch

- **F008.1 Durability:** Litestream sidecar/process replicates `/data/upmetrics.db` → Tigris bucket (arn); `litestream restore` on boot if volume is empty. Plus `fly volumes` daily snapshots + retention. Restore runbook in `docs/DURABILITY.md`.
- **F008.2 External watchdog:** Cloudflare Worker on a cron trigger (every 1–5 min) fetches `upmetrics.org/health` and `cronjobs.webhouse.net/health`; on failure posts to the deadman Discord webhook from the **edge** (not fly). This is the only piece deliberately NOT in arn.
- **F008.3 Storm-control:** a fleet-correlation pass groups simultaneous incidents across projects into a single "major outage" alert; a dependency model marks the watchdog/region signal as a suppressor for downstream per-site alerts; a maintenance-window table silences matching alerts; a global token-bucket rate-limit collapses overflow into a periodic digest.
- **F008.4 Storage-HA spike:** prototype Turso + Drizzle (and/or LiteFS), measure write path + failover, write an ADR + migration steps.
- **F008.5 Multi-region:** with the chosen store, scale to 2+ machines behind fly's proxy; verify a single-machine loss no longer causes downtime.
- **F008.6 Edge-buffer ingest (optional):** Worker + Cloudflare Queue accepts envelopes when origin is unreachable, replays to `/api/...` on recovery.

## Stories
- **F008.1** — Litestream → Tigris backup + daily fly snapshots + restore runbook (durability, Tier 0).
- **F008.2** — External off-fly watchdog (Cloudflare Worker cron) for region-level outage.
- **F008.3** — Fleet-scale alert-storm control: mass-outage roll-up, dependency-aware suppression, maintenance windows, global rate-limit/digest.
- **F008.4** — Storage-HA decision spike: Turso (libSQL) vs LiteFS — ADR + migration plan.
- **F008.5** — Multi-region runtime: 2+ machines behind fly anycast proxy (depends on F008.4).
- **F008.6** — (optional) Cloudflare edge-buffer ingest (Worker + Queue, replay on recovery).

## Acceptance criteria (epic-level)
1. A fresh machine can be restored from backup with zero (or near-zero) data loss, proven by a restore drill; daily snapshots are enabled.
2. A full arn outage (upmetrics + cronjobs unreachable) produces exactly ONE Discord alert from an off-fly source.
3. N simultaneous probe_down/incident events across the fleet collapse into ONE roll-up alert with a count, not N messages; a configured maintenance window suppresses alerts.
4. A storage-HA ADR exists choosing Turso or LiteFS with a concrete migration plan; multi-region run (F008.5) survives a single-machine loss with no downtime.

## Dependencies
- **F001** (schema), **F004** (probe_down + dead-man — F008.2 supersedes the on-fly watchdog dependency), **F005** (alert engine — F008.3 extends it).

## Rollout (phased)
1. **Now / next:** F008.1 (durability) + F008.2 (external watchdog) — small, high-value, directly address the 2026-05-30 incident.
2. **With F005:** F008.3 (storm-control) — lands alongside the alert engine.
3. **When upmetrics is genuinely load-bearing:** F008.4 → F008.5 (storage-HA → multi-region). F008.6 optional after that.

## Open questions
- Tigris bucket + credentials (arn) to be provisioned for Litestream.
- Turso vs LiteFS decision deferred to the F008.4 spike — do not pre-commit.
- Should the maintenance-window also auto-pull from fly's platform-status feed (so fly host-maintenance auto-silences)? Nice-to-have, evaluate in F008.3.
