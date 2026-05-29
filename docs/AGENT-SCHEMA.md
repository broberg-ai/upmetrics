# Agent Run Ingest Schema

> Implemented in F002.3 (`apps/server/src/ingest/agent.ts`). First-class AI
> agent telemetry — the Upmetrics differentiator (PLAN §8).

## Endpoint

```
POST /api/agent
```

## Auth

Header `X-Upmetrics-Key: <project api_key>`. Missing/invalid → `401
{"error":"invalid_api_key"}`.

## Modes

The JSON body's `mode` field selects the operation (default `record`).

### `start`

Creates an `agent_runs` row with `status='running'` and returns its id.

Required: `agent_kind`, `agent_name`, `provider`, `model`.
Optional: `task`, `purpose`, `tier`, `session_id`, `parent_run_id`, `tags`.

```json
→ { "mode":"start", "agent_kind":"cc", "agent_name":"planner",
    "task":"plan F042", "provider":"anthropic", "model":"claude-sonnet-4-6",
    "session_id":"s1" }
← { "run_id": "<uuid>" }
```

### `finish`

Finalizes a started run. Required: `run_id`. Sets `status` (default `success`),
`ended_at=now`, `duration_ms`, and the metric fields below.

```json
→ { "mode":"finish", "run_id":"<uuid>", "status":"success",
    "input_tokens":1200, "output_tokens":340, "cost_usd":0.012,
    "tool_calls":[{"name":"Read","count":5}] }
← { "ok": true, "run_id":"<uuid>" }
```

Unknown `run_id` for the project → `404 {"error":"unknown_run"}`.

### `record`

One-shot completed run (for externally-managed sessions, e.g. buddy-managed cc).
Required: `agent_kind`, `agent_name`, `provider`, `model`. Optional `started_at`,
`ended_at`, `duration_ms` + all metric fields.

```json
→ { "mode":"record", "agent_kind":"chatbot", "agent_name":"eir",
    "provider":"anthropic", "model":"claude", "status":"success",
    "input_tokens":50, "output_tokens":80, "cost_usd":0.001 }
← { "run_id": "<uuid>" }
```

## Metric fields (finish / record)

`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`
(default 0), `cost_usd` (default 0), `tool_calls` (`[{name,count,error_count}]`),
`artifacts` (`[{type,ref}]`), `prompt_excerpt`, `response_excerpt` (opt-in; null
for compliance projects), `error_issue_id`, `tags`.

## Persisted columns (`agent_runs`)

Mirrors PLAN §5: `id`, `schema_version` (default 1), `project_id`, `session_id`,
`parent_run_id`, `agent_kind`, `agent_name`, `task`, `purpose`, `provider`,
`model`, `tier`, `status` (`running|success|error|timeout|max_turns|abandoned`),
`started_at`, `ended_at`, `duration_ms`, token columns, `cost_usd`, `tool_calls`,
`artifacts`, `prompt_excerpt`, `response_excerpt`, `error_issue_id`, `tags`.

`purpose`, `provider`, `tier` are first-class columns (not just tags) for
compliance reporting + cost analytics without JSON parsing.
