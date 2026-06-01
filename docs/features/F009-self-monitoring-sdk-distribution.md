# F009 — Self-monitoring (dogfood) + SDK distribution

> Tier: high · Effort: M · Status: in progress

## Motivation

We love dogfooding (Christian, 2026-05-31): *"put Upmetrics in Upmetrics — faking a crash on our own platform is easy."* This also closes F003's standing-but-never-done constraint: **"Dogfood @upmetrics/sdk inside upmetrics itself from day one."** And it's the bridge to the bigger goal — making upmetrics the central health view for **all** WebHouse sites/apps, which requires the SDK to be **consumable from other repos** (published to npm). The npm org `@upmetrics` is ready (npmjs.com/settings/upmetrics/packages).

## Solution

Two moves, internal-first:

1. **Dogfood (internal, no publish):** the upmetrics server consumes its OWN `@upmetrics/sdk` (workspace package), inits against a self-monitoring `upmetrics` project, and captures server errors. A fake-crash trigger proves the loop end-to-end — the error lands as an issue in upmetrics' own dashboard.
2. **Publish + rollout:** publish `@upmetrics/sdk` to npm (`@upmetrics`), switch the deployed server to the published version (so the LIVE server self-monitors), then instrument FysioDK + the CMS web portals.

## Scope

### In scope
- **F009.1 Dogfood:** self-monitoring `upmetrics` project (DSN); server inits the SDK and captures `onError` + `unhandledRejection`; guarded behind a dynamic import + try/catch (a missing SDK must never crash boot — important because the standalone Docker `bun install` can't resolve `workspace:*`). A session-gated `/api/debug/boom` fake-crash trigger.
- **F009.2 Publish + rollout:** make `@upmetrics/sdk` publishable (private:false, version, `publishConfig.access=public`, tsc build → dist + .d.ts), publish, switch the server dep to the published version + deploy (live dogfood), instrument FysioDK + a CMS portal.

### Out of scope
- Agent SDK self-instrumentation of the server (the server isn't an AI agent).
- Publishing `@upmetrics/agent` (can follow the same path later).

## Architecture

- `apps/server/src/dogfood.ts`: `initDogfood()` reads `UPMETRICS_SELF_DSN`, dynamically imports `@upmetrics/sdk`, `init()`s it, and exposes `captureSelf(err, ctx)`. All guarded — if the SDK or DSN is absent, it's a no-op and the server boots normally.
- `app.ts` `onError` → `captureSelf(err, { url, method })` before the 500 response.
- The SDK posts a Sentry envelope to its DSN endpoint (upmetrics.org/api/upmetrics/envelope), so even a LOCAL server run lands the issue in the prod `upmetrics` project — visible in the live dashboard.

## Acceptance criteria
1. Server inits `@upmetrics/sdk` against the self-project DSN; init is guarded so a missing SDK never crashes boot.
2. An unhandled server error is captured to the `upmetrics` self-project.
3. A fake crash produces an issue in the self-project, visible in the dashboard.
4. `@upmetrics/sdk` is published to npm (@upmetrics, public, real build); the deployed server self-monitors on the published version.
5. At least one external portal (FysioDK or CMS) is instrumented and sends events.

## Dependencies
- **F002** (ingest/grouping — the self-project's errors group into issues).
- **F003** (the `@upmetrics/sdk` package).
- **F006** (dashboard — where the self-monitoring issues are seen).

## Open questions / blockers
- **npm auth**: `npm whoami` → E401. Publishing (F009.2) needs Christian's `npm login` to the `@upmetrics` org (or an automation token). The dogfood (F009.1) needs no publish.
- Live-server (deployed) dogfood requires the published SDK (the Docker standalone install can't resolve `workspace:*`); until then, F009.1 is proven by a local server run posting to the prod self-project.

## Rollout
F009.1 (internal dogfood, local-verified → prod self-project) → F009.2 (publish → switch server dep + deploy → live dogfood → instrument portals).
