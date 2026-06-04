# F015 — Project admin: create + reveal/copy/rotate API key

> Self-serve onboarding for new repos/"customers". Built 2026-06-04.

## Motivation

Every self-service surface (cost-ingest, issues list/resolve/resolve-all,
remediation enrollment) authenticates with the project's `api_key` as
`X-Upmetrics-Key`. But there was **no way to create a project or retrieve its
key** without raw DB access + a human relaying the secret over intercom (done ~6
times this week). Christian: "alle skal have en API key ... hvordan får nye repos
det automatisk?" + "et sted til at generere nye API keys til nye kunder".

The key is a SECRET, so it can't be handed out by an unauthenticated endpoint
(anyone could grab any project's key) and can't be derived from the public DSN.
The secure channel = the session-authed dashboard: create the project there, copy
the key, set it as the repo's `.env`/Fly-secret — then the repo always has it.

## Scope

- **`POST /api/dashboard/projects`** (session auth) — create: `{ id (slug), name,
  platform }`. Generates `publicKey = randomBytes(16).hex`, `dsn =
  https://<publicKey>@<host>/<id>` (host derived from `config.authBaseUrl` — NOT
  hardcoded), `api_key = uk_<randomBytes(24).hex>`. Validates slug (unique +
  `[a-z0-9-]`). Returns `{ project, dsn, api_key }`.
- **`GET /api/dashboard/projects/:id`** — add `credentials: { dsn, api_key }`
  (session-authed reveal; only the logged-in operator sees it).
- **`POST /api/dashboard/projects/:id/rotate-key`** — new `api_key`, persist,
  return it. Old key stops authenticating immediately.
- **UI:** ProjectDetail gets a **Credentials** card (DSN copy + api_key
  masked/reveal/copy + Rotate behind a custom confirm modal). Overview gets a
  **New project** action (modal form → create → show key/dsn to copy).
- **Docs:** `docs/ISSUES-API.md` for the self-service issues endpoints (F010.7).

## Non-goals

- No DSN public-key rotation in MVP (rotate the api_key only; the DSN is public).
- No multi-user / RBAC / key-expiry / multiple keys per project.
- No unauthenticated key handout (security).

## DSN / key contract (must match ingest)

The envelope route resolves a project by `:projectId` then checks the incoming
DSN's public key equals `extractPublicKey(project.dsn)` (the URL username). So a
generated DSN MUST be `https://<publicKey>@<host>/<id>` for error-capture to work
for the new project. `api_key` (`uk_<hex>`) is the `X-Upmetrics-Key` for all the
self-service surfaces.

## Acceptance criteria

See card AC. Verified: tests (create/reveal/rotate/dup-slug), typecheck, deployed,
live create-a-project smoke.
