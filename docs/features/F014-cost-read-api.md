# F014 — Cost read-API (apps fetch their accumulated LLM/agent cost)

> Tier: high · Status: planned · Proposed 2026-06-02.
> Read-only companion to the agent-cost ingest (F002.3 + @broberg/ai-sdk upmetricsSink).
> upmetrics is the **cost sink**; this epic lets each enrolled app read **its own**
> accumulated cost back out to render in its own UI.

## Motivation

`@broberg/ai-sdk`'s `upmetricsSink` now forwards every LLM/agent call's `Usage`
(tokens + `cost_usd` + provider/model/tier/capability/transport) to `agent_runs`
via `POST /api/agent`. Apps (trail first, then cms/xrt81/…) want to show their
own spend **inside their own product** — not just on the upmetrics dashboard. So
upmetrics needs a **read** surface, scoped per project.

## Input from trail (F151 Cost & Quality Dashboard, intercom #2381)

trail already shipped an internal cost dashboard over their `ingest_jobs.cost_cents`
(per-job granularity). They want to **cross-check** their numbers against ours
(per-call → finer). Their prioritized wishlist + hard-won pitfalls drive this design:

- **#1: summary per project/period** — `total`, tokens (in/out separate), split by
  provider/model/tier. window = day/week/month + custom from/to.
- timeseries buckets for a graph (they pad zero-days themselves → just send non-zero
  buckets + bucket size).
- filter by model + tier + **transport** (http vs subprocess/$0) — they distinguish
  Max-Plan free ($0) from metered; a `metered`/`transport` flag is "guld".
- auth: **read-key per project** (scoped), NOT a fleet-wide key; stored as a Fly secret.
- **money as integer (micro-USD/cents), NEVER float-dollars.**

### Pitfalls trail hit (bake these into the design)
1. **Caching vs freshness** — expose `generated_at`/`as_of` in every response so
   clients can show "updated at X" and reason about staleness.
2. **Currency** — store + serve **USD as source of truth**; conversion (e.g. DKK via
   FX) is the client's display concern. Server never does FX.
3. **Micro-rounding** — `round(usd*100)` destroys sub-½-cent calls ($0.00001 → 0 →
   wrongly "free"). **SUM in full precision; round ONCE at the response boundary**,
   never per row. This is the biggest trap for our per-call model.
4. **$0 ≠ unknown** — Max-Plan/subprocess calls cost a real $0. Emit an explicit
   `metered:false` rather than letting cost=0 look like missing data.
5. **Realtime vs batch** — per-call lands in realtime; an `as_of` cursor covers any
   eventual-consistency window.

## API design

Base: `GET /api/cost/*`. Auth: header `X-Upmetrics-Key: <project api_key>` (per-project,
already a secret — same key as ingest; reused read-side for v1). 401 on missing/invalid.
All money as **integer micro-USD** (`total_micro_usd`; $1 = 1_000_000). Every response
carries `generated_at` (ISO).

- **`GET /api/cost/summary?window=day|week|month&from=&to=`** — the #1 endpoint.
  Returns `{ generated_at, window:{from,to}, total_micro_usd, input_tokens, output_tokens,
  cache_read_tokens, cache_creation_tokens, run_count, metered:{metered_micro_usd,
  free_run_count}, by_provider[], by_model[], by_tier[], by_capability[] }` where each
  breakdown row = `{ key, micro_usd, input_tokens, output_tokens, run_count }`.
- **`GET /api/cost/timeseries?bucket=day|hour&from=&to=`** — non-zero buckets only:
  `{ generated_at, bucket:'day', points:[{ ts, micro_usd, input_tokens, output_tokens, run_count }] }`.
- **Filters (both endpoints):** `provider`, `model`, `tier`, `agent_name`, `transport`
  (`http`|`subprocess`). `transport`/`capability` live in `agent_runs.tags` JSON →
  filter/group via `json_extract(tags,'$.transport')`. `metered` is derived: a run is
  free when `tags.transport='subprocess'` OR `cost_usd=0`.

### Money handling (precision)
`agent_runs.cost_usd` is `REAL`. Aggregate as `SUM(cost_usd)` (full double precision),
then `total_micro_usd = round(sum * 1_000_000)` ONLY at the response boundary — never
round per row. (Future hardening noted below.)

## Stories
- **F014.1** — `/api/cost/summary` (total + tokens + by-provider/model/tier/capability,
  micro-USD, `generated_at`, per-project auth, metered split). The #1 deliverable.
- **F014.2** — `/api/cost/timeseries` (day/hour buckets, non-zero only).
- **F014.3** — filters (provider/model/tier/agent_name/transport) + `metered` derivation
  over `tags` JSON.
- **F014.4** — **public docs** `docs/COST-API.md` (open source): endpoints, auth, the
  micro-USD + USD-source-of-truth + `metered` + `generated_at` contracts, a worked
  example, and a note that clients do their own FX. Linked so fleet cc sessions can
  fetch it like AGENT-SCHEMA.md.

## Non-goals
- No currency conversion / FX (client display concern; serve USD).
- No write/mutation surface (read-only; ingest stays `POST /api/agent`).
- No per-call drill-down beyond what `agent_runs` already stores.
- No server-side cache in v1 (queries are cheap over indexed `agent_runs`; `generated_at`
  lets clients cache). Add a short TTL only if read load proves it necessary.

## Considerations / future
- **Read-scoped key:** v1 reuses the project ingest `api_key`. If a project wants to
  embed cost in a public/client surface, add a separate read-only key (don't expose the
  write-capable ingest key).
- **Integer-cost column:** if micro-rounding ever bites (huge call volumes), add an
  `agent_runs.cost_micro_usd` integer column at ingest and sum that instead of REAL.
- This is the most likely first trigger to revisit the storage-HA ADR ([0001](../adr/0001-storage-ha.md))
  — it is read-heavy; design so reads could later be served from a replica unchanged.
