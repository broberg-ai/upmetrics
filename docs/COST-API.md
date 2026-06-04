# Cost read-API

> F014. Read-only, per-project surface over `agent_runs` so an enrolled app can show
> its **own** accumulated LLM/agent cost in its own UI. Companion to the agent-cost
> ingest ([AGENT-SCHEMA.md](AGENT-SCHEMA.md)) that `@broberg/ai-sdk`'s `upmetricsSink`
> writes to. upmetrics is open source; this doc is public so any fleet cc session can
> fetch it.

## Auth

Header `X-Upmetrics-Key: <project api_key>` — the **same per-project key** used for
ingest (`uk_…`). It resolves the project; you only ever see your own data. Missing or
invalid key → `401 {"error":"invalid_api_key"}`. (NB: this is the cost-ingest `api_key`,
**not** the error-capture `DSN` — they are separate credentials.)

## Conventions (read these once)

- **Money is integer micro-USD** (`micro_usd`; `$1 = 1_000_000`). We `SUM(cost_usd)` in
  full precision and round **once** at the response boundary — never per row — so
  sub-cent calls ($0.00001) are not lost. Divide by `1_000_000` for USD; `/ 10_000` for
  US-cents.
- **USD is the source of truth.** We never do currency conversion — do your own FX in
  the display layer (and mark a stale rate yourself).
- **`metered` vs free.** A run is **free** when `transport = "subprocess"` (Max-Plan,
  `claude -p`) **or** `cost_usd = 0`. `metered_micro_usd` excludes those; `free_run_count`
  counts them. A real $0 ≠ missing data.
- **`generated_at`** (ISO-8601) is on every response — show "updated at X" / cache on it.

## `GET /api/cost/summary`

Totals + breakdowns for a window.

Query params (all optional): `window=day|week|month` (default `week`), or explicit
`from` / `to` (ISO-8601 or epoch-ms; override `window`). Filters: `provider`, `model`,
`tier`, `agent_name`, `transport` (`http|subprocess`), and any **`tag.<key>=<value>`**
(matches the `tags` JSON — e.g. `tag.tenantId=sanne` for per-tenant cost).

```jsonc
// GET /api/cost/summary?window=week
{
  "generated_at": "2026-06-02T09:40:00.000Z",
  "window": { "from": "2026-05-26T09:40:00.000Z", "to": "2026-06-02T09:40:00.000Z" },
  "total_micro_usd": 7407,            // = $0.007407
  "input_tokens": 1704,
  "output_tokens": 153,
  "cache_read_tokens": 0,
  "cache_creation_tokens": 0,
  "run_count": 1,
  "metered": { "metered_micro_usd": 7407, "free_run_count": 0 },
  "by_provider":   [{ "key": "anthropic", "micro_usd": 7407, "input_tokens": 1704, "output_tokens": 153, "run_count": 1 }],
  "by_model":      [{ "key": "claude-sonnet-4-6", "micro_usd": 7407, "input_tokens": 1704, "output_tokens": 153, "run_count": 1 }],
  "by_tier":       [{ "key": "vision", "micro_usd": 7407, "input_tokens": 1704, "output_tokens": 153, "run_count": 1 }],
  "by_capability": [{ "key": "vision", "micro_usd": 7407, "input_tokens": 1704, "output_tokens": 153, "run_count": 1 }]
}
```

Each breakdown row is `{ key, micro_usd, input_tokens, output_tokens, run_count }`,
ordered by cost desc. `tier`/`capability` fall back to `"(none)"` when absent.

### Group by a tag (`?groupBy=<key>`)

Add `groupBy=<tagKey>` to get cost broken down per distinct tag value — the
per-tenant view. `@broberg/ai-sdk` merges consumer `labels` (`tenantId`, `kbId`, …)
into `tags`, so one project key serves cost per tenant **without** a key per tenant.

```jsonc
// GET /api/cost/summary?groupBy=tenantId&window=month
{
  "...": "all the usual summary fields, PLUS:",
  "group_by": "tenantId",
  "by_group": [
    { "key": "bob",   "micro_usd": 40000, "input_tokens": 0, "output_tokens": 0, "run_count": 1 },
    { "key": "sanne", "micro_usd": 30000, "input_tokens": 0, "output_tokens": 0, "run_count": 2 }
  ]
}
```

Rows missing the tag fall back to `"(none)"`. The tag key must be an identifier
(`[A-Za-z_][A-Za-z0-9_]*`); other keys are ignored. **For reconciliation**: a
tenant's `micro_usd / 10_000` = US-cents, comparable to a caller-side
`SUM(cost_cents)` per tenant. **Leak note**: this returns *all* tenants — a
multi-tenant app showing one curator their cost must filter server-side with
`tag.tenantId=<that tenant>`, never expose the full `by_group`.

## `GET /api/cost/timeseries`

Per-bucket series for a graph. **Only non-zero buckets are returned** — pad missing
days/hours yourself.

Query params: `bucket=day|hour` (default `day`), same `window`/`from`/`to`/filters as
summary.

```jsonc
// GET /api/cost/timeseries?bucket=day&window=month
{
  "generated_at": "2026-06-02T09:40:00.000Z",
  "bucket": "day",
  "window": { "from": "2026-05-03T09:40:00.000Z", "to": "2026-06-02T09:40:00.000Z" },
  "points": [
    { "ts": "2026-06-02T00:00:00Z", "micro_usd": 7407, "input_tokens": 1704, "output_tokens": 153, "run_count": 1 }
  ]
}
```

## Example

```bash
curl -s https://upmetrics.org/api/cost/summary?window=month \
  -H "X-Upmetrics-Key: $UPMETRICS_API_KEY" | jq '.total_micro_usd / 1000000'
```

## Fleet read — `GET /api/cost/fleet` (org-wide, per-agent)

Cross-project per-agent cost for an org-level digest (buddy's daily Discord
"fleet cost" report). Unlike the project-scoped endpoints above, this aggregates
**every** project's runs by `agent_name`.

**Auth is different**: a dedicated org read-token in header
`X-Upmetrics-Fleet-Key` (NOT a project `uk_` key — a project key never satisfies
this endpoint). Read-only, cost-aggregates only (no PII/excerpts). The token is a
server secret (`FLEET_READ_KEY`); empty → endpoint returns 401 (disabled).

Query: `?window=1d|24h|7d|30d|day|week|month` (default `1d`) or explicit
`?from=&to=` (ISO-8601 or epoch-ms).

```bash
curl -s "https://upmetrics.org/api/cost/fleet?window=1d" \
  -H "X-Upmetrics-Fleet-Key: $UPMETRICS_FLEET_READ_KEY"
```
```json
{
  "generated_at": "2026-06-05T06:00:00Z",
  "window": { "from": "2026-06-04T06:00:00Z", "to": "2026-06-05T06:00:00Z" },
  "total_usd": 8.17, "total_micro_usd": 8170000, "run_count": 142,
  "by_agent": [
    { "agent_name": "trail", "runs": 53, "cost_usd": 4.97, "micro_usd": 4970000, "metered_micro_usd": 4970000, "free_runs": 0 },
    { "agent_name": "buddy", "runs": 61, "cost_usd": 3.13, "micro_usd": 3130000, "metered_micro_usd": 3130000, "free_runs": 0 }
  ]
}
```

Money: `cost_usd` (float, for display) + `micro_usd` (integer, for reconciliation,
`$1 = 1_000_000`). Per-agent rounds at each agent boundary; `total_micro_usd`
rounds once from the raw SUM.

## Notes / limits

- Read-only. Ingest stays `POST /api/agent` ([AGENT-SCHEMA.md](AGENT-SCHEMA.md)).
- No server-side cache in v1 (queries are cheap over indexed `agent_runs`); use
  `generated_at` to cache client-side.
- Project endpoints reuse the ingest `api_key` (`X-Upmetrics-Key`). The fleet
  endpoint uses a SEPARATE org read-token (`X-Upmetrics-Fleet-Key`) — cross-project
  read is a deliberately distinct credential, never the write-capable ingest key.
