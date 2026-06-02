# ADR 0001 — Storage HA: Turso/libSQL vs LiteFS vs single-node + Litestream

> Decision spike for **F008.4**. Status: **Proposed** (recommendation below; revisit triggers defined). Author: upmetrics cc, 2026-06-02.

## Context

upmetrics runs on **one** fly.io machine in `arn`, `bun:sqlite` at `/data/upmetrics.db` on a named volume, Drizzle (`drizzle-orm/bun-sqlite`). Durability today: **Litestream → Tigris** (S3-compatible, continuous WAL replication, F008.1) + an **off-fly Cloudflare Worker watchdog** (F008.2). WAL + `busy_timeout=5000` + `synchronous=NORMAL`.

We are **deliberately single-machine**: a named volume auto-provisions a **separate** volume per machine, so scaling to >1 machine gave each its own divergent DB → **split-brain** (inconsistent reads, split auth sessions). Fix was `fly scale count 1` + destroy the orphan. So "just add machines" is exactly the failure mode we already hit.

The open question F008.4 asks: **what is the durable HA path** when/if single-node is no longer acceptable — Turso/libSQL, LiteFS, or stay as-is?

What "HA" would buy us: survive a machine/host failure without manual restart, and (secondarily) scale reads across regions. What it costs: operational complexity + (for some options) an app-level driver change or an external dependency.

## Options

### A. Stay single-node + Litestream→Tigris (status quo)
- **Pros:** simplest; zero new moving parts; `bun:sqlite` stays; already shipped + replicating. Durability is solved (restore from Tigris). Single writer = no split-brain possible. No external runtime dependency (Max-plan-friendly, no API-heavy service).
- **Cons:** **not HA** — a machine/host failure means downtime until fly restarts the machine (seconds–minutes) or, worst case, a restore-from-snapshot (the documented runbook, [[upmetrics-deadman-disabled]]). No read scaling. RPO = Litestream replication lag (seconds); RTO = restart/restore time.

### B. LiteFS (FUSE replication, single primary + read replicas)
- **Pros:** **keeps `bun:sqlite` + Drizzle bun-sqlite driver — zero app code change** (LiteFS is transparent at the filesystem layer). fly-native. **Single-primary model with write-forwarding directly prevents the split-brain we hit** — replicas are read-only copies of one authoritative DB, not independent volumes. Automatic primary failover via Consul lease. Read replicas can sit in multiple regions.
- **Cons:** real operational complexity — FUSE mount, Consul lease, primary-handoff semantics, "writes only on primary" gotchas (must route writes / handle the forwarding). LiteFS Cloud was de-emphasised by fly; the OSS LiteFS still works but is less actively shepherded. Another daemon in the container.

### C. Turso / libSQL (embedded replicas, remote primary)
- **Pros:** modern, actively developed (libSQL is the maintained sqlite fork). **Embedded replicas** = fast local reads synced from a remote primary, writes sent to primary. Managed (Turso cloud, free tier) or self-host `sqld` on fly. Drizzle supports it (`drizzle-orm/libsql`). Multi-region reads are first-class.
- **Cons:** **requires an app-level driver swap** — `bun:sqlite` → `@libsql/client` + `drizzle-orm/libsql` (touches `db/index.ts`, migrations, every query path's typing). Writes go **over the network** to the primary → added write latency + a network dependency on the hot ingest path. Managed Turso = an **external dependency** (against the "avoid API-heavy / keep it on our infra" preference); self-hosted `sqld` = we now operate the libSQL server ourselves (back to "who's the primary" + the same single-writer question). Litestream (same author, sqlite-native) would likely be dropped in favour of libSQL's own replication.

## Decision (recommended)

**Stay on Option A (single-node + Litestream→Tigris) for now. Do NOT adopt HA yet.**

Rationale: upmetrics is an **internal** telemetry tool, not a customer-facing SLA service. Its consumers (the fleet SDKs) are **fire-and-forget** — a few minutes of ingest downtime during a rare machine restart loses at most a sliver of telemetry (and the SDKs' POSTs simply fail silently, by design). Durability — the thing that actually matters for a telemetry store — is **already solved** by Litestream→Tigris + the watchdog. The split-brain incident proved that *adding nodes naively is the risk*, not the cure; neither LiteFS nor Turso is justified by current criticality, and both add real complexity (FUSE/Consul, or a driver swap + network-writes) for marginal benefit at this scale.

**If/when HA becomes necessary, prefer Option B (LiteFS) over C (Turso):** it keeps `bun:sqlite` (no driver migration), is fly-native, and its single-primary model is the direct antidote to the split-brain failure mode we already experienced. Turso's embedded-replica model is elegant but the `bun:sqlite`→libSQL driver swap + network-writes on the ingest hot path + external/managed dependency don't fit our lean, Max-plan, on-our-infra posture.

## Revisit triggers (when to reopen this ADR)

Adopt LiteFS (Option B) when **any** of:
1. **Uptime requirement** — upmetrics gains a real SLA / a customer-facing surface where minutes of downtime is unacceptable.
2. **Read scale / latency** — dashboard or API read load (see the planned cost-read API) needs multi-region replicas, or single-node read latency degrades.
3. **Restore RTO too slow** — a real machine-loss event shows restart/restore time is unacceptable in practice.
4. **Write volume** — ingest write throughput approaches single-node sqlite limits (unlikely soon; telemetry is bursty but small).

Until a trigger fires: keep single-node, keep `fly scale count 1` (the split-brain guard), keep Litestream replicating, and verify the restore runbook periodically.

## Consequences

- No code change now. F008.5 (multi-region runtime) stays **blocked on this ADR** and should NOT be picked up — multi-region with the current named-volume-per-machine setup is precisely the split-brain trap; it requires Option B (LiteFS) first.
- The cost-read API (new work, modelled from trail's needs) is a **read-heavy** addition — it's the most likely first trigger for revisiting (#2). Design it so reads could later be served from a replica without API changes.
- This ADR is the durable record so future sessions don't re-litigate "why aren't we on Turso/multi-region."

## Addendum 2026-06-02 — single-node flap-hardening (shipped, F008.7)

A real incident validated the "stay single-node" choice but exposed a fragility: a backed-up Litestream→Tigris sync + a writer-triggered inline WAL checkpoint stalled the **synchronous** `bun:sqlite` write for 50–78s, freezing the single event loop so even DB-free `/health` couldn't answer within the 2s check timeout → fly dropped the only instance from tcp/443 → ~12-min flapping outage. `fly machine restart` recovered it (fresh Litestream connection; WAL writes back <1s).

Since the ADR keeps us single-node, we **harden** single-node instead of adding HA:
1. **`PRAGMA wal_autocheckpoint = 0`** (`db/index.ts`) — Litestream owns checkpointing; app writes only append to the WAL and never run a long inline checkpoint on the request path. A slow Tigris now degrades durability gracefully (WAL grows, RPO rises) instead of freezing the event loop.
2. **Tolerant health check** (`fly.toml`: timeout 2s→5s, grace 10s→30s) — a brief stall no longer drops the single instance from tcp/443.

This does not change the HA recommendation; it makes the recommended posture robust to the failure mode we actually hit. The deeper fragility (sync `bun:sqlite` on the event loop) is only fully removed by moving HA (LiteFS) or off-thread sqlite — still gated by the revisit triggers above.
