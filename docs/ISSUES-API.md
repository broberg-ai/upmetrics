# Issues API (self-service)

> F010.7. Read + resolve your project's error issues **headless** — no dashboard
> login. Auth is the same per-project key as cost/enrollment. Public doc so any
> fleet repo can run the "fix → resolve → clean board" loop itself. Companion to
> [COST-API.md](COST-API.md) + [REMEDIATION-ENROLLMENT.md](REMEDIATION-ENROLLMENT.md).

## Auth

Header `X-Upmetrics-Key: <project api_key>` (`uk_…` / `ak_…`) — the **same key**
used for cost-ingest + enrollment. You only ever see/touch your own project's
issues. Missing/invalid → `401`. Store it as the repo's `UPMETRICS_API_KEY`
(Fly secret / `.env`) — it's a secret, never the public DSN.

> First-time: grab the key from the project's page in the upmetrics dashboard
> (Credentials card → reveal/copy), or create the project there (it shows the key
> once). Then it lives in the repo's secret and the repo always has it.

## `GET /api/issues`

Your project's issues. Default: **unresolved** only; `?status=resolved|ignored|unresolved`
for an exact filter.

```jsonc
{
  "project": "trail",
  "issues": [
    { "id": "…", "title": "TypeError: …", "culprit": "src/x.ts", "level": "error",
      "status": "unresolved", "event_count": 9, "first_seen": "…", "last_seen": "…" }
  ]
}
```

## `POST /api/issues/:id/resolve`

Resolve (or ignore / reopen) one issue. Body `{ "status"?: "resolved" | "ignored"
| "unresolved" }`, default `resolved`. `404` if the issue isn't your project's.

```bash
curl -X POST https://upmetrics.org/api/issues/$ID/resolve \
  -H "X-Upmetrics-Key: $UPMETRICS_API_KEY" -H 'content-type: application/json' -d '{}'
```

## `POST /api/issues/resolve-all` — clear slate

Resolve (or ignore) **all** your project's currently-open issues in one call —
for mass-noise (e.g. a dev reload-storm that floods the board). Body `{ "status"?:
"resolved" | "ignored" }`, default `resolved`. Returns the count.

```bash
curl -X POST https://upmetrics.org/api/issues/resolve-all \
  -H "X-Upmetrics-Key: $UPMETRICS_API_KEY" -H 'content-type: application/json' -d '{}'
# → { "ok": true, "project": "buddy", "resolved": 2, "status": "resolved" }
```

## Keeping the board clean

- Bump `@upmetrics/sdk` to **≥0.1.5** — its benign-network filter drops
  `Failed to fetch` / `Load failed` / chunk-load noise from auto-capture, so only
  real errors land. Most fleet noise is this class.
- Resolve your issues when you ship the fix (per-id) — or `resolve-all` after a
  one-off flood. A clean board means real signals stand out.
