# Remediation enrollment API

> F010.5. **Self-service**: a repo enrols itself into upmetrics' auto-remediation
> relay (or a human toggles it on the dashboard project page). When enrolled,
> qualifying error spikes are relayed to Buddy → a live cc session in your repo,
> which fixes the root cause and deploys. Public doc so any fleet session can
> self-enrol. Companion to the [cost read-API](COST-API.md) and [F010](features/F010-auto-remediation-relay.md).

## Auth

Header `X-Upmetrics-Key: <project api_key>` — the **same per-project key** used for
cost-ingest (`uk_…`). It resolves your project; you only ever touch your own
enrollment. Missing/invalid → `401 {"error":"invalid_api_key"}`. (NB: this is the
cost-ingest `api_key`, **not** the error-capture `DSN` — separate credentials.)

## `GET /api/remediation/enrollment`

Your current enrollment:

```jsonc
{
  "project": "trail",
  "enabled": false,            // auto-relay opt-in
  "repo": null,                // basename Buddy maps to your cc session (e.g. "trail")
  "github_repo": null,         // "owner/repo" for the Create-GitHub-issue deep-link
  "severity": null,            // your min-severity gate; null = inherit the global default
  "effective_severity": "high" // what actually applies (your override ?? global)
}
```

## `PUT /api/remediation/enrollment`

Partial update — **only the keys you send are changed**.

| field | type | meaning |
|---|---|---|
| `enabled` | bool | opt into auto-relay |
| `repo` | string \| null | basename Buddy maps to your cc session |
| `github_repo` | string \| null | `"owner/repo"` for the issue deep-link |
| `severity` | `"low"`\|`"medium"`\|`"high"`\|`"critical"`\| null | min severity to auto-relay; `null` = inherit the global default |

```bash
# enrol yourself
curl -X PUT https://upmetrics.org/api/remediation/enrollment \
  -H "X-Upmetrics-Key: $UPMETRICS_API_KEY" -H 'content-type: application/json' \
  -d '{"enabled":true,"repo":"trail","severity":"medium"}'
```

Returns the updated enrollment view. An unknown `severity` → `400 {"error":"invalid_severity","allowed":[…]}`.

## What enrollment actually does

- With `enabled:true` **and** `repo` set, your `error_spike` / `agent_failure_spike`
  incidents at/above `effective_severity` enter the feed Buddy polls; Buddy relays
  to your repo's live cc session. Unclaimed > 30 min → escalates to Christian.
- **Manual "Push to remediation"** on an issue ALWAYS relays, regardless of these
  settings (explicit user intent bypasses the opt-in + severity gates).
- **Severity gotcha:** a normal `error_spike` is `medium` (it only becomes `high`
  at ≥3× the spike threshold). So with the default global gate (`high`), set
  `severity:"medium"` if you want everyday spikes to auto-relay.

## Dashboard equivalent

The same controls live on each project's page in the upmetrics dashboard
(the **Auto-remediation** card): opt-in toggle, repo, severity. Same validate +
write path as this API — no drift.
