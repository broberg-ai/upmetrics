# Envelope Ingest Spec

> Implemented in F002.1 (`apps/server/src/ingest/`). A strict subset of the
> Sentry envelope protocol — enough that official Sentry SDKs treat Upmetrics
> as a Sentry server.

## Endpoint

```
POST /api/{project_id}/envelope/
```

## Auth — DSN public key

The DSN public key must match the project's stored DSN. Provide it via either:

- query: `?sentry_key=<publicKey>` (what Sentry SDKs append), or
- header: `X-Sentry-Auth: Sentry sentry_key=<publicKey>, sentry_version=7, ...`

The project's DSN format is `https://<publicKey>@upmetrics.org/<project_id>`.
Mismatch or missing key → `401 {"error":"invalid_dsn"}`. Unknown project →
`404 {"error":"unknown_project"}`.

## Body — newline-delimited envelope

```
<envelope header JSON>\n
<item header JSON>\n
<item payload>\n
<item header JSON>\n
<item payload>\n
...
```

Item headers may carry a byte `length`; when present the parser slices exactly
that many bytes (payload may then contain newlines). Otherwise the payload is
the next single line.

## Item types (Phase 1)

| type          | handling                                  |
| ------------- | ----------------------------------------- |
| `event`       | **stored** as `events.kind='error'`; grouped into an issue (F002.2) |
| `transaction` | **stored** raw (`kind='transaction'`), not displayed yet |
| `check_in`    | **stored** raw (`kind='check_in'`)        |
| `attachment`  | **dropped** (no session replay in Phase 1) |
| `session`     | **dropped** (no release health in Phase 1) |
| (other)       | dropped                                   |

Unsupported types never fail the whole envelope.

## Response

```json
{ "accepted": <number stored>, "dropped": <number dropped> }
```

## Persisted fields (`events`)

`id` (event_id from payload/header, else generated), `project_id`, `kind`,
`received_at`, `occurred_at` (payload `timestamp`, else now), `payload` (full
JSON), `issue_id` (set by grouping for errors), `release`, `environment`, `tags`.

## Example

```bash
printf '{"event_id":"abc","sentry_key":"PUBKEY"}\n{"type":"event"}\n{"event_id":"abc","level":"error","exception":{"values":[{"type":"TypeError","value":"x is undefined","stacktrace":{"frames":[{"function":"fetchUser","filename":"src/api/users.ts"}]}}]}}\n' \
| curl -X POST "https://upmetrics.org/api/PROJECT/envelope/?sentry_key=PUBKEY" --data-binary @-
# => {"accepted":1,"dropped":0}
```
