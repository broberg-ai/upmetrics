# F024 — provider/model/tier filters on `/api/cost/fleet`

## Why

buddy is chasing a €53 Mistral bill whose ~91% is invisible to Upmetrics (a
costSink gap in `@broberg/ai-sdk`, fixed separately). To *prove* that Mistral
spend appears — then drops — after the SDK fix, buddy needs a fleet-wide,
per-`agent_name` cost read filtered to `provider=mistral`.

The only cross-project read is `GET /api/cost/fleet` (auth header
`x-upmetrics-fleet-key`, validated timing-safe against `config.fleetReadKey`).
Today `costFleet()` (`apps/server/src/cost/routes.ts`) filters **only** by the
time window and `GROUP BY agent_name` — it ignores `provider`/`model`/`tier`.
So it returns cost-per-agent across **all** providers and cannot isolate
mistral. That's the gap.

## What (surgical)

Append the same optional predicates the project-scoped `buildWhere()` already
implements (`routes.ts:70-73`: `provider`, `model`, `tier`, `agent_name`) to
`costFleet()`'s span. Build a `parts` array seeded with the time-window
predicate, push each optional filter, `sql.join(parts, ' AND ')`, and reuse
that single joined expression in BOTH queries (the per-agent breakdown and the
grand-total) so they stay consistent. No project predicate — fleet stays
cross-project by design. No auth change. No new params beyond the four that
`buildWhere` already honours (match existing idiom, per house rule 3).

Usage: `GET /api/cost/fleet?window=month&provider=mistral`.

## Non-goals

- No tag/`groupBy` support on the fleet endpoint (that's the project-scoped
  `/summary` surface; fleet always groups by `agent_name`).
- No change to auth, headers, or the response shape.
- Does not address the SDK costSink gap itself (separate ai-sdk work).

## Story

F024.1 — implement the filter + a CI-blocking test. AC lives on the story.

## Harness

The cost read is fleet-facing but not user-load-bearing; the seal is the
automated test running in CI (it fails if the filter silently stops excluding
non-matching providers). Verify live post-deploy with a real `?provider=mistral`
fleet call.
