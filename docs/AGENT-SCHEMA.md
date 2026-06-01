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

## For cost-sink authors (`@broberg/ai-sdk` → `upmetricsSink`)

`@broberg/ai-sdk` emits a camelCase `Usage` per call; this endpoint's wire format
is **snake_case**, and the ingest is **lenient** — it validates nothing beyond the
four required fields and **silently drops any field it does not read** (see
`metrics()` in `ingest/agent.ts`). So `upmetricsSink` is a thin but *real* adapter,
not a 1:1 pass-through. Build it from this table — anything not listed is dropped.

### `Usage` → wire mapping

| `Usage` (camelCase) | wire field | notes |
|---|---|---|
| — (**required**) | `agent_kind` | NOT in `Usage` — sink must inject. Enum advisory only (not enforced); use `chatbot` for SDK calls, `embedding` for embeddings. |
| — (**required**) | `agent_name` | NOT in `Usage` — sink must inject. Configure per consumer (e.g. `cms`, `trail`), NOT the capability. Dashboards group "runs per agent_name". |
| `provider` | `provider` | required, pass-through |
| `model` | `model` | required, pass-through |
| `tier` | `tier` | pass-through; **free text** — `cheap`/`vision` accepted & stored, no enum reject |
| `capability` | `tags.capability` | **dropped if sent top-level** — route via `tags` |
| `transport` | `tags.transport` | **dropped if sent top-level** — route via `tags` (`http`/`subprocess`) |
| `inputTokens` | `input_tokens` | |
| `outputTokens` | `output_tokens` | |
| `cacheReadTokens` | `cache_read_tokens` | |
| `cacheCreationTokens` | `cache_creation_tokens` | |
| `costUsd` | `cost_usd` | `0` for subprocess — fine |
| `toolCalls[].errorCount` | `tool_calls[].error_count` | **deep rename** inside each array element |
| `latencyMs` | `duration_ms` | rename; OR send `started_at`+`ended_at` and let the server compute it |
| `ts` | `started_at` | ISO-8601 or epoch ms; set `ended_at` = `ts` (+ latency) |
| `purpose` | `purpose` | pass-through (compliance label) |

### Required minimum body (else `400 missing_fields`)
`agent_kind`, `agent_name`, `provider`, `model`. Auth header `X-Upmetrics-Key:
<project api_key>` (per-project; `401` on missing/invalid).

### Mode choice
- one-shot completed call → `mode:"record"` (default).
- streamed / long call → `mode:"start"` (returns `run_id`) then `mode:"finish"`
  with `run_id` + metrics. Map the SDK's `agentRun()` lifecycle onto this; map a
  resolved call onto `record`. Do **not** also use `@upmetrics/agent.wrapAnthropic`
  inside the SDK — the SDK already owns the provider call (double-instrumentation).

### Example `record` body the sink should POST
```json
{ "mode":"record", "agent_kind":"chatbot", "agent_name":"cms",
  "provider":"google", "model":"gemini-2.0-flash", "tier":"cheap",
  "input_tokens":420, "output_tokens":180, "cost_usd":0.00009,
  "tool_calls":[{"name":"none","count":0,"error_count":0}],
  "started_at":"2026-06-02T10:00:00.000Z", "ended_at":"2026-06-02T10:00:01.200Z",
  "purpose":"ui-string-translation",
  "tags":{"capability":"translate","transport":"http","sdk":"@broberg/ai-sdk@0.1.0"} }
```

### Open decision for the ai-sdk team
`transport` (free Max-subprocess vs paid API) lives only in `tags` for v1. If
dashboards need free/paid as a first-class axis beyond `cost_usd=0`, ping the
upmetrics session — a `transport` column + dashboard facet is a small migration
here. Same offer for `capability`. Default v1: keep both in `tags`.
