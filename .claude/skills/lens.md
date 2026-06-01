---
name: lens
description: Visually verify a surface (screenshot + baseline diff + DOM assert) via the cardmem daemon's Lens engine. Use before moving a card with a visual AC to Done, or to regression-check UI. No Playwright in this repo — the daemon owns the browser.
---

# Lens — visual verification (cardmem daemon, F074)

Lens confirms a UI surface **looks + behaves right** before a card moves to Done.
The browser (Playwright/Chromium) lives in the **cardmem daemon** (`127.0.0.1:7475`),
not in this repo. You call it; it returns pass/fail + a screenshot, an optional
pixel-diff vs an approved baseline, and an optional DOM assertion.

**`data-testid` is the contract.** Anchor every verification on a stable
`[data-testid="…"]`, never a CSS/text guess. See `TESTID-CONVENTION.md`.

## When to use

- A card has a **visual AC** → `lens_verify` the surface, attach the result.
- Before Done on UI work → run the project's `lens.manifest.json` via `/lens/gate`.
- Regression-check after a UI change → re-run against approved baselines.

## How to call it

**Preferred — MCP tools** (the `cardmem-lens` server in this repo's `.mcp.json`):

```
lens_verify({
  project: "<this-project-slug>",
  url: "http://localhost:<dev-port>/dashboard",
  mode: "element",                       // viewport | fullPage | element
  selector: "[data-testid=\"dashboard-root\"]",
  baseline_key: "dashboard",             // omit for a render-only check
  assert: "return { pass: document.querySelector('[data-testid=cta]').offsetWidth > 120 }"
})
// → { status: "pass"|"fail"|"no-baseline"|"error", screenshot_url, diff_url, diff_ratio, assert_detail }
```

`lens_capture` (screenshot only), `lens_approve_baseline({ project, run_id, baseline_key })`,
`lens_capture_catalogue` (batch), `lens_list_runs` round out the surface.

**Or HTTP** (CLI/CI): `POST 127.0.0.1:7475/lens/verify` with the same body; the
whole-surface gate is `POST 127.0.0.1:7475/lens/gate { "local_path": "<repo>" }`.

## The manifest + the gate

Commit a `lens.manifest.json` at the repo root listing your surfaces:

```json
{
  "project": "<slug>",
  "base_url": "http://localhost:<dev-port>",
  "auth": { "adapter": "storageState", "stateEnv": "<PROJECT>_STORAGE_STATE" },
  "surfaces": [
    { "name": "landing", "path": "/", "mode": "viewport", "baseline_key": "landing", "auth": null },
    { "name": "dashboard", "path": "/dashboard", "mode": "element",
      "selector": "[data-testid=\"dashboard-root\"]", "baseline_key": "dashboard" }
  ]
}
```

`POST /lens/gate { local_path }` reads it, verifies every surface, cross-checks
each element selector's testid against the repo (a non-existent anchor is a hard
**block** — "a visual AC cannot pass without its anchor"), and returns one
`{ verdict: "green"|"red" }`. First run = `no-baseline`; approve a good shot, then
re-runs pixel-diff against it.

## Auth (authed routes)

The credential lives on the **daemon side**, never in the call. Mark **public**
surfaces `auth: null` (a logged-in visitor often gets redirected off them).
Three adapters, in order of how clean they are:

1. **`mintEndpoint`** (best — scoped, no standing credential). Your app exposes a
   protected endpoint that mints a SHORT-LIVED, READ-ONLY session and returns it
   as a storageState JSON. The daemon calls it just before each capture and
   discards the session after. Nothing standing on disk, nothing in the transcript.
   ```json
   "auth": { "adapter": "mintEndpoint",
             "url": "https://<app>/api/lens-session",
             "secretPath": ".lens/mint-secret" }
   ```
   The endpoint authes on `Authorization: Bearer <secret>` (a NARROW "mint a lens
   session" key, not an admin session) and returns
   `{ "cookies": [ { "name": "...", "value": "...", "domain": "...", "secure": true } ], "origins": [] }`.
   The secret comes from `secretPath` (a gitignored file, relative → repo root) or
   `secretEnv`.

2. **`storageState` via `statePath`** (good — a file, no env/restart). Generate a
   Playwright `storageState.json`, gitignore it, and point the manifest at it:
   ```json
   "auth": { "adapter": "storageState", "statePath": ".lens/storage-state.json" }
   ```
   A relative `statePath` resolves against the repo root. Use a read-only user if
   you can — a stored session cookie is a real credential.

3. **`storageState` via `stateEnv`** (legacy). Same JSON, but behind a daemon env
   var (`auth.stateEnv`). Note: `launchctl setenv` only reaches NEW daemon spawns,
   so this needs a daemon restart to inject — prefer `statePath` or `mintEndpoint`.

## Gotchas (learned dogfooding cardmem)

- `waitUntil` is `load`, not `networkidle` — an SPA with an open SSE/websocket
  never goes network-idle.
- **Self-referential surfaces** (a dashboard that displays the very runs you're
  generating) can't have a stable pixel baseline — use a render-check (omit
  `baseline_key`) or an `assert`.
- Dynamic data (lists, timestamps) drifts a pixel baseline — prefer an `assert`
  for those, or re-approve the baseline on intentional changes.

## Docs

Always-current API/MCP reference: `GET https://services.cardmem.com/api/lens/docs`
(no auth). Convention: `TESTID-CONVENTION.md` (scaffolded into this repo).
