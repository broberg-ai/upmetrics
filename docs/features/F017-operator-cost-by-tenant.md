# F017 — Operator cost breakdown by tenant (dashboard groupBy view)

> Tier: medium · Status: in progress · Owner: upmetrics backend + web

## Motivation

Trail stamps `labels:{tenantId,kbId}` on every AI call → `agent_runs.tags` carries
per-tenant attribution, and the F014 cost read-API already supports
`?groupBy=<tagKey>` (verified: `groupBy=tenantId` returns per-tenant cost). But the
upmetrics **dashboard UI** had no per-tenant view — only per-agent on the Agents
page. Christian GO (relayed via trail): add an operator-scoped per-tenant cost
breakdown so broberg-ai vs Sanne are visible side-by-side.

## Scope

### In scope
- `GET /api/dashboard/cost?project=<id>&groupBy=<tagKey>&window=<w>` — session-authed,
  reuses the F014 `costSummary` aggregation (zero new query logic). Returns the
  `by_group` breakdown. `400 project_required` without a project.
- Agents page: a **Cost by tenant (7d)** card, project-scoped, with a dimension
  select (tenant / knowledge base) + a `{key, runs, cost}` table. Hint when no
  project is selected (costSummary is project-scoped).

### Non-goals
- Per-curator / tenant-facing exposure. This is OPERATOR-only.
- New aggregation — it reuses `costSummary(groupBy)` verbatim.
- Grouping by non-tag columns (model/provider/tier already have fixed breakdowns).

## Cross-tenant leak guard

`?groupBy=tenantId` returns ALL tenants — a known leak risk for a per-curator panel.
Here it's safe **by construction**: the upmetrics dashboard is admin-login-only
(Better Auth + allowlist, cb@/mb@). No tenant-curator can reach it, so an
all-tenants view is inherently operator-scoped. (The per-curator guard remains
trail's responsibility on their F151/F190.5 panel — they server-side-filter by the
caller's tenantId.)

## Architecture

- Server: `dashboard/routes.ts` → new GET route imports `costSummary` from
  `cost/routes.ts`, gated by `requireUser`. No new SQL.
- Web: `routes/Agents.tsx` → `CostByGroup` sub-component (mounted only when a
  project is selected), `useApi('/dashboard/cost?…')`, dimension `CustomSelect`,
  breakdown table. `usd(micro_usd / 1e6)` for display.

## Rollout

Ship server + web; Lens-verify the Agents page (mint adapter) shows the card; trail
reconciles `by_group[tenant].micro_usd / 1e6` against their `ingest_jobs.cost_cents`.
