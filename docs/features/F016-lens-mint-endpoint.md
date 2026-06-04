# F016 — Lens mint-endpoint (short-lived read-only visual-verification session)

> Tier: high · Status: in progress · Owner: upmetrics backend

## Motivation

Lens (cardmem's visual-verification daemon) needs to log into the upmetrics
dashboard to capture + diff surfaces. Today it uses a **static** `storageState`
file (`.lens/storage-state.json`) — effectively a real, long-lived session that
can go stale and runs as a privileged user. The Christian-approved fleet standard
(cardmem `docs/LENS-MINT-ENDPOINT.md`, F098.1/F074.13) replaces that with a
**mint endpoint**: the daemon presents a Bearer secret and receives a
short-lived, READ-ONLY session for a dedicated lens principal — never cb@/admin.

## Scope

### In scope
- `POST /api/lens-session` — Bearer-gated (`LENS_MINT_SECRET`) → returns a
  Playwright `storageState` carrying one short-lived (10 min) lens cookie.
- Lens principal recognised by `requireUser` **on GET only** → structurally
  read-only (mutating methods can never authenticate as lens).
- Manifest wiring: `auth = {adapter:'mintEndpoint', url, secretPath:'.lens/mint-secret'}`.
- Secret: `openssl rand -hex 32`, set as a Fly secret AND written to the
  gitignored `.lens/mint-secret` the daemon reads (never over intercom).

### Non-goals
- A general read-only **role** in the dashboard (upmetrics is single-admin). The
  lens principal is a synthetic token, not a standing DB account.
- Rotating/multi-tenant lens identities. One mint secret per repo.

## Architecture

`auth/lens.ts`:
- `sign(expMs)` → `"<expMs>.<hmac(authSecret, 'lens.'+expMs)>"`.
- `POST /api/lens-session`: timing-safe Bearer check vs `config.lensMintSecret`;
  on success returns `{cookies:[{name:'upm_lens', value, domain, path:'/',
  httpOnly:true, secure:true, sameSite:'Lax', expires}], origins:[]}` (TTL 10m).
- `validLensSession(c)`: parse the `upm_lens` cookie, reject expired/tampered/
  malformed (timing-safe HMAC compare).

`requireUser` (dashboard): real Better Auth session → full access; else a valid
lens cookie authorises **GET only**. A mutating method with only a lens cookie
falls through to 401 — so the lens session can read every dashboard surface but
mutate nothing.

### Deviation from the canonical recipe (deliberate)
The fleet recipe suggests a dedicated Better Auth **user row** + a real session
cookie, with a 403 write-guard. upmetrics instead uses a **synthetic signed
cookie** + a GET-gate, because reproducing Better Auth's internal signed-cookie
format outside a request context is version-fragile (a Better Auth upgrade could
silently break it). Same security outcome — dedicated lens identity, never
cb@/admin, short-lived, read-only — with no standing account to compromise.
Mutations return 401 (structural) rather than 403 (explicit); functionally
identical (lens cannot mutate).

## Rollout
1. Ship code (endpoint + requireUser + tests) behind an empty secret (endpoint
   stays 401 until the secret is set — safe to deploy first).
2. `openssl rand -hex 32` → `flyctl secrets set LENS_MINT_SECRET` + write to
   `.lens/mint-secret` (gitignored).
3. Flip `lens.manifest.json` auth to the mint adapter.
4. Lens runtime-verify a surface via the mint adapter against prod.

## Dependencies
- cardmem `docs/LENS-MINT-ENDPOINT.md` (canonical contract) + daemon mintEndpoint
  adapter (`context.addCookies`).
