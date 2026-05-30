# Remediation webhooks (F005.3)

Upmetrics **never runs commands, spawns processes, or executes code**. When an
incident is serious it does exactly one thing: **POST a signed payload to a URL
the project configured**. The receiver (e.g. cardmem, an app's self-heal
endpoint) decides what to do and may report back. That decoupling is what keeps
upmetrics small and safe.

## When it fires

On the incident worker tick (~30s), for each **open** incident where:

- `severity >= REMEDIATION_THRESHOLD` (default `medium`), **and**
- the project has a `remediation_webhook_url`, **and**
- the incident has not been dispatched before (`remediation_attempts` is null).

Dispatched **once** per incident.

## Request

`POST <project.remediation_webhook_url>`

Headers:
- `content-type: application/json`
- `x-upmetrics-signature: sha256=<hex>` — HMAC-SHA256 of the raw body using the
  project's `remediation_webhook_secret`. Verify before trusting the payload.

Body:
```jsonc
{
  "incident": { "id", "project_id", "kind", "severity", "title", "opened_at" },
  "remediation_token": "<opaque>",      // use this to authenticate the callback
  "callback_url": "https://upmetrics.org/api/incidents/<id>/remediation-callback",
  "recent_events": [ { "id", "kind", "occurredAt", "issueId" }, ... ],      // last 10
  "recent_agent_runs": [ { "id", "agentName", "status", "costUsd" }, ... ]  // last 10
}
```

## Retries

Up to `REMEDIATION_RETRIES` (default 3) attempts with exponential backoff
(`REMEDIATION_BACKOFF_MS` base, ×2 each retry). Stops on the first 2xx. **Every
attempt + response** is logged to `incidents.remediation_attempts.attempts[]`
(`{ at, attempt, status, ok }` or `{ at, attempt, error }`), alongside `token`,
`callback_url`, and `delivered`.

## Callback

The receiver reports the outcome:

`POST /api/incidents/{id}/remediation-callback`
- Auth: `x-upmetrics-remediation-token: <token>` header (or `remediation_token`
  in the body) — must match the dispatch token.
- Body: `{ "status": "...", "detail"?: "..." }`

Recorded to `incidents.remediation_attempts.callbacks[]` as
`{ at, status, detail }` — the incident timeline.

## Phase 1 routing

One remediation URL per project. Routing to specific handlers is the
**receiver's** job (e.g. cardmem decides which board/agent acts on it). See
F005.4 for the cardmem integration (blocked on cardmem-F067 exposing
`POST /api/incidents`).
