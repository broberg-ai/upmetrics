# F001 — Foundation & Auth

> Tier: critical · Effort: M (Uge 1) · Status: planned

## Motivation

Upmetrics has a 37 KB Phase-1 plan (`docs/UPMETRICS-PLAN.md`) but zero code. Every other epic (ingest, SDKs, probes, dashboard) depends on a monorepo skeleton, a migrated database, a booting server, and working auth. This epic is the substrate — nothing else can start until it exists.

## Solution

Stand up the pnpm + Turbo monorepo with all five workspaces, author the full Drizzle schema + migrations for every Phase-1 table, boot a Hono server with a `/health` endpoint, wire Better Auth magic-link with an email allowlist, and deploy to fly.io (region `arn`) with bun:sqlite on a mounted volume.

## Scope

### In scope
- `pnpm-workspace.yaml` + `turbo.json` + the 5 packages: `apps/server`, `apps/web`, `packages/shared`, `packages/sdk`, `packages/agent` (PLAN §4).
- Drizzle schema for all Phase-1 tables (PLAN §5): `projects`, `events`, `issues`, `agent_runs`, `probes`, `probe_results`, `incidents`, `alert_rules`, `alert_history`. Migrations apply to fresh bun:sqlite.
- `apps/server` Hono skeleton: app bootstrap, config loading (dotenv), `/health` route, error middleware.
- Better Auth magic-link (PLAN F16): single org, email allowlist (`cb@webhouse.dk`, `mb@webhouse.dk`). Per-project API keys are defined in schema here but issued in F002.
- fly.io deploy: `fly.toml` (region `arn`), volume for sqlite, secrets via `fly secrets`, custom-domain placeholder.

### Out of scope
- Any ingest endpoint logic (F002).
- Any SDK code (F003).
- Dashboard UI beyond an empty Vite+Preact shell wired to auth (F006 owns real pages).
- Retention/rate-limiting (F007).

## Architecture

### Monorepo (PLAN §4)
pnpm workspaces + Turbo. ES modules. `apps/server` (Hono), `apps/web` (Vite+Preact), `packages/{shared,sdk,agent}`.

### Schema (`packages/shared` + `apps/server/src/db`)
Drizzle table definitions mirroring PLAN §5 verbatim, including `agent_runs.schema_version` (default 1) and jsonb columns (`tags`, `tool_calls`, `payload`). Migrations live in `apps/server/src/db/migrations`.

### Auth (Better Auth)
Magic-link via Resend. Allowlist enforced in the sign-in callback. Session cookie. `cb@webhouse.dk` permanent admin.

### Deploy
`fly.toml` region `arn`, `[mounts]` for `/data` sqlite volume. `DATABASE_PATH` env points at the volume.

## Stories
- **F001.1** — Monorepo skeleton (pnpm + Turbo, 5 empty workspaces, shared tsconfig/prettier).
- **F001.2** — Drizzle schema + migrations for all Phase-1 tables.
- **F001.3** — Hono server skeleton + config + `/health`.
- **F001.4** — Better Auth magic-link + allowlist.
- **F001.5** — fly.io deploy scaffolding (region arn, sqlite volume, secrets).

## Acceptance criteria
1. Monorepo builds clean with all 5 workspaces present.
2. Drizzle migrations apply to a fresh bun:sqlite DB with no error; all §5 tables exist.
3. Hono server boots and `/health` returns 200 locally.
4. Magic-link login works for an allowlisted email; non-allowlisted is rejected.
5. App deploys to fly.io region `arn` with sqlite volume mounted; `/health` reachable over HTTPS.

## Dependencies
- None — this is the root epic. Everything else depends on it.

## Rollout
Single-phase. Build locally, dogfood the DB, then deploy to fly.io. No feature flags needed. Rollback = redeploy previous image.

## Open Questions
- Primary domain (`upmetrics.io` vs `.org` vs `.net`) — PLAN §13.1, Christian decides. Does not block local build; only the fly custom-domain step.

## Effort estimate
**M** — ~1 week (Uge 1 in PLAN §12).
