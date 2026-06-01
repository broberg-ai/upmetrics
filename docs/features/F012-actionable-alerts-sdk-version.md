# F012 — Actionable alerts: incident deep-link + SDK-version visibility

## Motivation
Two real gaps surfaced 2026-06-01:
1. **Alerts aren't actionable.** A Discord alert ('[MEDIUM] … Error spike — 12 errors') gives no way to jump to the case. Christian wants the embed to link straight to the flagged incident. **No token / no auto-login** — he's already authenticated via cookie, and a clickable admin-login URL in a Discord channel would be insecure. Just a plain deep-link.
2. **SDK version is invisible.** xrt81's '15 err' was mostly 401-noise from an outdated SDK (0.1.0), discoverable only by *inferring* the version from capture behaviour. Events carry no SDK version, so fleet drift is invisible.

## Scope
- **SDK self-version stamp.** Add `sdk: { name: '@upmetrics/sdk', version }` to every event (Sentry-style). Version is single-sourced from `package.json` — a `scripts/gen-version.mjs` writes `src/version.ts` at build (rootDir:src forbids importing `../package.json`; no hardcoded constant). Bump → 0.1.3, publish via the OIDC `sdk-v*` tag.
- **Discord deep-link.** `sendDiscord` adds `url` to the embed title → `${authBaseUrl}/incidents?id=<incidentId>` (no token). `Incidents.tsx` reads `?id=` and opens that incident's detail on mount.
- **Dashboard version display.** `/api/dashboard/projects/:id` returns each surface's `sdk_version` (`json_extract(payload,'$.sdk.version')`, latest event per release) + the newest version seen; `ProjectDetail` shows `· sdk X.Y.Z` per component, amber when behind.
- **Notify the fleet.** After 0.1.3 publishes, intercom every member (trail, cardmem, xrt81, fysiodk, cms, sanneandersen, buddy) to update + redeploy. Versions then populate the dashboard.

## Non-goals
- No auth/token in the alert link (explicit constraint).
- No new schema column — the sdk version lives in the event payload JSON.

## Verification
- Fresh event carries `sdk.version` (DB check). Discord embed title is a clickable link to the incident. ProjectDetail shows per-surface version + amber-on-drift. Lens GREEN. Members pinged.

## Rollout
Ship SDK 0.1.3 (npm) + deploy upmetrics (alerts + dashboard). Members update on their own redeploy; the dashboard fills in versions as they ship — closing the loop with the notify-fleet workflow ([[sdk-change-notify-fleet]]).