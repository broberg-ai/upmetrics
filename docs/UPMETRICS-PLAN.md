# UPMETRICS — Phase 1 Plan

> **Codename:** Upmetrics
> **Domains:** upmetrics.org (primary), upmetrics.net, upmetrics.io (secondary)
> **Purpose:** Internt, uafhængigt telemetry/monitoring-værktøj til alle WebHouse sites, web-apps og native apps. Erstatter behovet for Sentry + UptimeRobot på tværs af Christians portfolio.
> **Owner:** Christian (solo dev + maintenance)
> **Status:** Planning — Phase 1 design lock

---

## 1. Goals & Non-Goals

### Goals (Phase 1)

- Ét sted at se helbredet af alle Christians sites, apps og services.
- Sentry envelope-protokol kompatibilitet på ingest (zero migration cost ved senere brug af native Sentry SDKs).
- Førsteklasses **AI Agent Monitoring** — ikke en bolt-on. cc-sessions, cardmem-dispatched agenter, Eir-chatbot, cctalk pipeline skal alle være søgbare og målbare.
- **Capacitor apps i drift** (iOS + Android) skal kunne sende både JS- og native fejl via `@sentry/capacitor` mod Upmetrics DSN — uden vi bygger egen native SDK.
- **Compliance-bevidst design** — `compliance_mode`-flag og `return_audit_record`-helper så apps i regulerede sektorer (FysioDK) kan have deres egen primære audit log mens Upmetrics modtager sanitiseret operationel telemetri.
- **Remediation hooks** — Upmetrics udfører ikke remediation selv, men kalder konfigurerede webhooks (cardmem, custom endpoints, fremtidigt cc-spawning-tool) når incidents opstår.
- Genbrug `cronjobs.webhouse.net` som probe scheduler — ingen ny scheduler-infrastruktur.
- Drift på fly.io (samme platform som cronjobs, buddy, cctalk — kendt territorium).

### Non-Goals (Phase 1)

- **Logs.** For dyrt at skalere ingest, presser stack mod ClickHouse/Loki. Genovervejes i Phase 2.
- **Session replay.** Højvolumen-binær storage, nice-to-have ikke must-have.
- **Distributed tracing / spans.** Errors + agent runs er nok til Phase 1.
- **Multi-tenant SaaS.** Single-tenant, single-org. Hvis det nogensinde bliver kommercielt er det Phase 3+.
- **SDK'er for sprog Christian ikke bruger.** Ingen Python, Go, Java, Ruby SDK. TS/JS + (optional) Swift kun hvis nødvendigt.
- **Egen on-call / paging.** Resend + Discord er nok.

### Non-Goals der bliver til Goals via Sentry-kompatibilitet

Fordi ingest-endpointet er Sentry envelope-kompatibelt, er følgende **gratis** uden vi behøver pakke noget:

- Capacitor apps via `@sentry/capacitor`
- Swift/iOS via `sentry-cocoa` (hvis Music Quiz tvOS app eller cctalk iPhone-app skal sende fejl)
- Flutter via `sentry_flutter`
- Kotlin/Android via `sentry-android`

Vi bygger ikke disse SDKs. Vi dokumenterer "peg DSN'en hertil og det virker."

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Apps & Sites                             │
│   Next.js sites · Hono APIs · Capacitor · cc sessions · buddy   │
│   cardmem · Eir chatbot · cctalk · Music Quiz · CMS · WHop      │
└──────────┬──────────────────────────────────┬───────────────────┘
           │ errors + agent runs              │ probe targets
           ▼                                  │
┌─────────────────────────┐                  │
│  UPMETRICS INGEST       │                  │
│  ─ /api/{id}/envelope/  │◄─── probe result │
│  ─ /api/agent           │     POSTs        │
│  ─ /api/probe-result    │                  │
└──────────┬──────────────┘                  │
           │                                  │
           ▼                                  │
┌─────────────────────────────────┐    ┌────────────────────────┐
│  UPMETRICS CORE                 │    │ cronjobs.webhouse.net  │
│  ─ Grouping / dedup             │    │ ─ HTTP/TCP/keyword     │
│  ─ Issue lifecycle              │    │ ─ SSL expiry           │
│  ─ Agent run aggregation        │◄───┤ ─ Probe scheduler      │
│  ─ Incident correlation         │    │ ─ Croner-driven        │
│  ─ Alert rules                  │    └────────────────────────┘
└──────────┬───────────────┬──────┘
           │               │
           ▼               ▼
┌──────────────────┐  ┌──────────────────────────────────────────┐
│  ALERT SINKS     │  │  REMEDIATION WEBHOOKS                    │
│  ─ Resend email  │  │  ─ POST to configured URL per project    │
│  ─ Discord       │  │  ─ Payload: incident + recent events     │
│  ─ Webhook       │  │  → cardmem / cc-spawn tool / app callback│
└──────────────────┘  └──────────────────────────────────────────┘
                                              │
                                              ▼
┌──────────────────────────────────────────────────────────────────┐
│  UPMETRICS DASHBOARD (Vite + Preact + shadcn)                    │
│  Projects · Issues · Agents · Probes · Incidents · Alerts        │
└──────────────────────────────────────────────────────────────────┘
```

**Key architectural choices:**

- **cronjobs.webhouse.net er probe-executor**, ikke Upmetrics. Vi definerer probes i Upmetrics-UI'et og synkroniserer til cronjobs via dens API. cronjobs udfører faktisk HTTP-calls og POSTer resultatet til `/api/probe-result/`.
- **bun:sqlite på fly.io volume** som storage. Samme mønster som cronjobs, simpelt, billigt, mere end nok til Christian-skala.
- **Single binary deployment.** Hono-server på fly.io. Ingen Kafka, ingen Redis, ingen ClickHouse i Phase 1.
- **Background work** via Hono `setInterval` worker eller cronjobs.webhouse.net hvis det er periodisk (dedup compaction, retention cleanup).

---

## 3. Stack

Følger Stack B (lean/fast) fra etableret stack-filosofi:

| Component | Choice | Rationale |
|---|---|---|
| Runtime | Bun | Native TS, hurtig opstart, indbygget sqlite |
| HTTP | Hono 4.6 | Lean, hurtig, samme som buddy/cms |
| ORM | Drizzle | Type-safe |
| DB | bun:sqlite på fly.io volume | Zero-config, billigt, samme mønster som cronjobs |
| Validation | Zod | Standard |
| Frontend | Vite 5 + Preact 10 | Lille, hurtig, samme som buddy |
| UI | Tailwind v4 + shadcn/ui | Standard |
| Charts | Recharts | Allerede brugt i cronjobs |
| Auth | Better Auth (magic link) | Standard for WebHouse værktøjer |
| Email | Resend | Konfigureret |
| Notifications | Discord webhooks | Konfigureret |
| Monorepo | pnpm + Turbo | Standard |
| Deploy | fly.io | Samme platform som cronjobs, buddy, cctalk |

---

## 4. Monorepo Layout

```
upmetrics/
├── apps/
│   ├── server/              # @upmetrics/server — Hono backend
│   └── web/                 # @upmetrics/web — Vite + Preact dashboard
├── packages/
│   ├── shared/              # @upmetrics/shared — types, Zod schemas, envelope parser
│   ├── sdk/                 # @upmetrics/sdk — TS/JS SDK for apps
│   └── agent/               # @upmetrics/agent — AI agent telemetry helpers
├── docs/
│   ├── UPMETRICS-PLAN.md    # this file
│   ├── ENVELOPE-SPEC.md     # Sentry envelope endpoint contract
│   ├── AGENT-SCHEMA.md      # agent_run event schema
│   └── REMEDIATION.md       # webhook payload spec
├── CLAUDE.md
├── pnpm-workspace.yaml
└── turbo.json
```

---

## 5. Data Model

Drizzle schema sketch. bun:sqlite for både dev og prod (fly.io volume).

### projects

```typescript
projects {
  id: text primary key            // slug, e.g. "trail", "cms", "sanne"
  name: text                      // display name
  dsn: text unique                // Sentry-compatible DSN
  api_key: text unique            // for non-envelope endpoints
  platform: text                  // "web" | "node" | "capacitor" | "native"
  remediation_webhook_url: text?  // POSTed when incident fires
  remediation_webhook_secret: text?
  alert_email: text?              // override default
  alert_discord_webhook: text?
  retention_days: integer default 30
  created_at, updated_at
}
```

### events (raw event log, append-only)

```typescript
events {
  id: text primary key           // event_id from envelope
  project_id: text fk
  kind: text                     // "error" | "message" | "agent_run" | "probe_result"
  received_at: timestamp
  occurred_at: timestamp
  payload: jsonb                 // full event body
  issue_id: text fk?             // populated by grouping job
  release: text?                 // deploy marker correlation
  environment: text?             // "production" | "staging" | etc.
  tags: jsonb                    // map<string, string>
}
```

### issues (deduplicated error groups)

```typescript
issues {
  id: text primary key
  project_id: text fk
  fingerprint: text               // hash of exception type + top frame
  title: text                     // e.g. "TypeError: Cannot read 'x' of undefined"
  culprit: text                   // e.g. "src/api/users.ts in fetchUser"
  status: text                    // "unresolved" | "resolved" | "ignored"
  level: text                     // "error" | "warning" | "info"
  first_seen: timestamp
  last_seen: timestamp
  event_count: integer
  user_count: integer
  assignee: text?
  resolved_in_release: text?
}
```

### agent_runs (specialized agent telemetry)

```typescript
agent_runs {
  id: text primary key
  schema_version: integer default 1  // for future-proofing
  project_id: text fk
  session_id: text?               // groups runs in a cc session, etc.
  parent_run_id: text fk?         // for sub-agent spawning
  agent_kind: text                // "cc" | "subagent" | "chatbot" | "rag" | "embedding"
  agent_name: text                // "cardmem-planner", "eir", "cc-sonnet-4-5"
  task: text                      // short description, no PII
  purpose: text?                  // "formaal" — compliance label (e.g. "symptom_screening")
  provider: text                  // "anthropic" | "openai" | "google" | "deepinfra" | etc.
  model: text                     // "claude-sonnet-4-5"
  tier: text?                     // "fast" | "smart" | "powerful" | "embedding" (per @webhouse/ai)
  status: text                    // "running" | "success" | "error" | "timeout" | "max_turns" | "abandoned"
  started_at: timestamp
  ended_at: timestamp?
  duration_ms: integer?
  input_tokens: integer
  output_tokens: integer
  cache_read_tokens: integer
  cache_creation_tokens: integer
  cost_usd: real
  tool_calls: jsonb               // [{name, count, error_count}]
  artifacts: jsonb                // [{type, ref}]
  prompt_excerpt: text?           // opt-in per project; null for compliance projects
  response_excerpt: text?         // opt-in per project; null for compliance projects
  error_issue_id: text fk?        // link to issue if crashed
  tags: jsonb
}
```

**Why `purpose`, `provider`, `tier` are first-class columns (not just tags):** Compliance reporting (FysioDK) and cost analytics need to filter/group on these without parsing JSON. They matcher audit-log-kravene direkte.

### probes

```typescript
probes {
  id: text primary key
  project_id: text fk
  name: text
  kind: text                      // "http" | "tcp" | "keyword" | "ssl"
  target: text                    // URL or host:port
  config: jsonb                   // expected_status, keyword, timeout_ms, etc.
  interval_seconds: integer
  cronjobs_job_id: text?          // ref to cronjobs.webhouse.net job
  status: text                    // "up" | "down" | "degraded" | "paused"
  last_check_at: timestamp?
  last_response_ms: integer?
  consecutive_failures: integer default 0
}
```

### probe_results (history, retention-controlled)

```typescript
probe_results {
  id: text primary key
  probe_id: text fk
  checked_at: timestamp
  ok: boolean
  response_ms: integer?
  status_code: integer?
  error: text?
}
```

### incidents

```typescript
incidents {
  id: text primary key
  project_id: text fk
  kind: text                      // "probe_down" | "error_spike" | "agent_failure_spike"
  status: text                    // "open" | "acknowledged" | "resolved"
  severity: text                  // "critical" | "high" | "medium" | "low"
  title: text
  opened_at: timestamp
  resolved_at: timestamp?
  trigger_ref: text               // probe_id, issue_id, or agent metric ref
  remediation_attempts: jsonb     // [{at, webhook_url, response_status, response_body}]
  events_at_open: jsonb           // snapshot of recent related events
}
```

### alerts (rule + history)

```typescript
alert_rules {
  id, project_id, kind, condition, channels, enabled, ...
}

alert_history {
  id, alert_rule_id, fired_at, payload, channels_sent, errors
}
```

---

## 6. Modules (Feature Numbers)

### F01 — Project Management
- CRUD projects, generate DSN + API key
- Settings: alert channels, remediation webhook, retention

### F02 — Sentry Envelope Ingest (`POST /api/{project_id}/envelope/`)
- Parse newline-delimited envelope format
- Validate against project DSN
- Persist as `events`
- Hand off to grouping worker async

See `docs/ENVELOPE-SPEC.md` for protocol details.

### F03 — Error Grouping
- Fingerprint = hash(exception.type + normalized top stack frame)
- Match to existing issue or create new
- Update `last_seen`, `event_count`, `user_count`
- Reopen if previously resolved

### F04 — Agent Run Ingest (`POST /api/agent`)
- Authenticated by project API key (`X-Upmetrics-Key`)
- Two modes:
  - **`start`** — creates `agent_run` with status=`running`, returns `run_id`
  - **`finish`** — updates `agent_run` with final state
- Also supports single-shot `record` for completed runs
- See `docs/AGENT-SCHEMA.md`

### F05 — Agent Telemetry SDK (`@upmetrics/agent`)
- `agentRun({ ... }, async (ctx) => { ... })` — lifecycle wrapper
- `wrapAnthropic(anthropic, opts)` — proxy that auto-tracks `messages.create`
- `ctx.recordToolCall(name, { error })`, `ctx.recordCost(usage)`
- Buddy integration: helpers for emitting cc-session telemetry from buddy's session manager

### F06 — Probes — Definition & cronjobs.webhouse.net sync
- Define probes in Upmetrics UI
- On save: call cronjobs.webhouse.net API to create/update a job that:
  - On schedule, executes the check
  - POSTs result to `https://upmetrics.{tld}/api/probe-result/{probe_id}` with HMAC
- Status sync runs every N seconds

### F07 — Probe Result Ingest (`POST /api/probe-result/{probe_id}`)
- HMAC-signed payload
- Persist to `probe_results`
- Update probe.status based on consecutive_failures threshold
- Generate `incidents` of kind `probe_down` if threshold exceeded

### F08 — Incident Correlation Engine
- Background worker (every 30s)
- Correlates:
  - probe_down + recent error_spike on same project → single incident
  - agent_failure_spike + recent deploy → tagged incident
- Updates incident severity dynamically

### F09 — Alert Engine
- Rule evaluator on incident open/escalate
- Channels: Resend email, Discord webhook, generic webhook
- Dedup window per rule (no spam)

### F10 — Remediation Webhook Dispatcher
- On incident open with `remediation_webhook_url` configured:
  - Build payload (incident + last N events + last N agent runs for context)
  - POST with HMAC signature
  - Log attempt + response to `incidents.remediation_attempts`
- Retry: 3 attempts with backoff
- See `docs/REMEDIATION.md`

### F11 — Dashboard — Overview
- Per-project health card: probe up%, open issues, agent cost today, open incidents
- Global health matrix view: all projects, status indicators, trends

### F12 — Dashboard — Issues
- List, filter, search, group
- Detail view: stack trace, breadcrumbs, tags, occurrence timeline, related agent runs
- Actions: resolve, ignore, assign, link to GitHub issue

### F13 — Dashboard — Agents
- List of agent runs with filters (kind, name, status, project, date range)
- Aggregates: cost per project per day, runs per agent_name, success rate, p95 duration
- Detail: full run with tool call timeline, token breakdown, link to error issue if crashed
- Session view: all runs in same `session_id` (e.g. one cc session)

### F14 — Dashboard — Probes
- Grid of probes per project with up/down status, response time sparkline
- Detail: history chart, last failure reason
- Manage: pause/resume, edit interval, delete (cascades to cronjobs job removal)

### F15 — Dashboard — Incidents
- Open incidents bar at top of every page
- Detail: timeline, trigger events, remediation attempts log
- Actions: acknowledge, resolve, manually trigger remediation

### F16 — Auth (Better Auth + magic link)
- Single org, allowlist email (cb@webhouse.dk, mb@webhouse.dk)
- API keys for SDK ingest (per project)

### F17 — Retention & Compaction
- Per-project retention_days (default 30)
- Daily compaction job: delete events older than retention
- agent_runs retention may be longer (analytics value)
- probe_results compacted to hourly aggregates after 7 days

### F18 — Rate Limiting & Quotas
- Per-project ingest rate limit (events/minute)
- Hard cap on storage per project (drop with warning event when exceeded)
- Configurable per project

### F19 — Dead-man's-switch
- External heartbeat: cronjobs.webhouse.net pings Upmetrics every 5 min
- If 2 consecutive misses → Discord alert via cronjobs (separate channel)
- Prevents silent monitoring failure

### F20 — TS/JS SDK (`@upmetrics/sdk`)
- Browser + Node + Bun compatible
- `init({ dsn, environment, release })`
- `captureException(err, ctx?)`, `captureMessage(msg, level)`
- `setUser`, `setTag`, `addBreadcrumb`
- Auto-instrument: `window.onerror`, `unhandledrejection`, fetch wrapper
- PII scrubbing (configurable): drop Authorization/Cookie headers, mask email/CPR/phone patterns
- Re-exports `agent` module for convenience

### F21 — Capacitor / Native App Support

Christian har Capacitor apps i drift på iOS og Android. Phase 1 understøtter fejl-rapportering fra disse uden at vi bygger en dedikeret SDK.

**Strategi:** Brug `@sentry/capacitor` officielt SDK pegende på Upmetrics DSN. Det wrap'er native `@sentry/cocoa` (iOS) og `@sentry/android` (Android) under hjelmen. Sentry envelope-kompatibiliteten gør at vi modtager events identisk med hvordan Sentry ville modtage dem.

**Hvad der virker out-of-the-box:**
- JS-fejl i Capacitor WebView (`@sentry/browser` baseline)
- Native iOS crashes (objc/swift exceptions)
- Native Android crashes (JVM + NDK)
- Breadcrumbs, user context, release tags

**Phase 1 arbejde:**
- Verificér envelope-parser håndterer alle item-types fra `@sentry/capacitor`
- Test mod én rigtig Capacitor app før Phase 1 close — vælg den mest aktive (sandsynligvis Music Quiz hvis den når Capacitor-stadium, ellers Sanne's app eller anden i drift)
- Dokumentér `init`-konfiguration i `docs/SDK-CAPACITOR.md`
- Definér standard tags-konvention for native (platform, os_version, app_version, device_model)

**Eksplicit udskudt til Phase 2:**
- iOS dSYM upload + symbolication endpoint (native crashes vises som rå adresses indtil da)
- Android ProGuard mapping upload
- RUM/heartbeats fra apps (probing af app-runtime selv)

**Probing af Capacitor-app-backends:** Allerede dækket af F06 — cronjobs.webhouse.net checker app-API-endpoints fra ekstern host. Det er det rigtige sted at probe, ikke fra app-klienten.

### F22 — Audit Log Mirroring Helper (FysioDK-mønster)

Adresserer compliance-distinktionen mellem operationel telemetri og juridisk bindende audit log.

**Position:** Upmetrics er **operationel observability**, ikke compliance audit log. Disse må aldrig konflateres.

| Aspekt | Audit log (app-ejet) | Upmetrics agent_runs |
|---|---|---|
| Source of truth | Ja, juridisk bindende | Nej, telemetri-kopi |
| Storage | App's egen DB | Upmetrics DB |
| Retention | 5–10 år | 30 dage (default) |
| Failure mode | Synchronous, blocker request | Fire-and-forget, må miste |
| Tamper-evidence | Append-only, evt. hash-chain | Ikke et krav |
| Adgang | Auditor, evt. Datatilsyn | Kun Christian |
| Klar-tekst PII | Aldrig | Aldrig (SDK-scrubbing) |

**SDK pattern — én kode-vej, to outputs:**

```typescript
import { agentRun } from '@upmetrics/agent';

const { result, auditRecord } = await agentRun({
  agent_kind: 'chatbot',
  agent_name: 'fysiodk-symptom-checker',
  project_slug: 'fysiodk',
  purpose: 'symptom_screening',     // formaal
  provider: 'anthropic',            // leverandoer
  model: 'claude-sonnet-4-5',
  tier: 'smart',
  return_audit_record: true,        // signal SDK to return structured payload
}, async (ctx) => {
  return await anthropic.messages.create({ ... });
});

// App-side: persist audit record SYNCHRONOUSLY before responding to user
await db.insert(aiAuditLog).values({
  user_id: userId,
  request_id: requestId,
  ...auditRecord,  // timestamp, purpose, provider, model, tier, tokens, cost
});

// (Upmetrics modtog samme data async; appens audit log er source of truth)
```

**`auditRecord` indeholder kun:** timestamp, agent_kind, agent_name, purpose, provider, model, tier, input_tokens, output_tokens, cost_usd, status, duration_ms, error_class (hvis fejlet). **Aldrig** prompt/response excerpts, **aldrig** klar-tekst brugerdata.

**FysioDK-konfiguration:** SDK initialiseres med `compliance_mode: true` → prompt/response excerpts force-disabled, PII-scrubbing aggressiv, alle telemetri-events får tag `compliance: 'gdpr-health'` så de let kan filtreres/eksporteres ved DSAR.

**Hvad helper'en IKKE er:** den giver dig ikke tamper-evidence, hash-chaining eller GDPR-eksport. Det er app'ens eget ansvar med dens egen audit log-tabel. Upmetrics SDK leverer bare de strukturerede felter.

---

## 7. Sentry Envelope Compatibility

We implement a strict subset of the Sentry envelope protocol — enough that Sentry's official SDKs treat us as a Sentry server.

**Endpoint:** `POST /api/{project_id}/envelope/`
**Auth:** DSN public key in `X-Sentry-Auth` header or query string
**Body:** Sentry envelope format (newline-delimited JSON with headers + items)

**Supported item types in Phase 1:**
- `event` (errors, messages) — full support
- `transaction` — **stored but not displayed** in Phase 1 (transactions = traces, deferred)
- `attachment` — **dropped** (no session replay)
- `session` — **dropped** (no release health in Phase 1)
- `check_in` — **stored** (Sentry's cron monitoring format, optional bridge from cronjobs)

**Why this matters:** Christian gets to use any official Sentry SDK by pointing the DSN at `https://upmetrics.{tld}/api/{project_id}`. No custom SDK install required for Capacitor, Swift, Flutter, etc. — `npm install @sentry/capacitor` just works.

Detailed spec in `docs/ENVELOPE-SPEC.md`.

---

## 8. AI Agent Monitoring (Differentiator)

Dette er det modul der gør Upmetrics nyttig ud over hvad GlitchTip allerede gør.

### Use cases der skal kunne besvares

1. *"Hvad kostede cc-kørsler på trail-projektet i denne uge?"*
2. *"Hvilke cardmem-dispatched agenter fejlede i går?"*
3. *"Vis mig hele session-traceen for cc-session der dispatched 4 sub-agenter."*
4. *"Hvilke værktøjer fejler oftest når Eir-chatbotten svarer?"*
5. *"Er der token-cost spikes der korrelerer med fejlede deploys?"*
6. *"Find langtidskørende agenter (>5 min) i dag — er nogen i hænge?"*

### SDK shape

```typescript
// packages/agent/src/index.ts (sketch)

import { agentRun, wrapAnthropic } from '@upmetrics/agent';

// Pattern 1: Lifecycle wrapper
const result = await agentRun({
  agent_kind: 'subagent',
  agent_name: 'planner-sonnet',
  task: 'Plan feature F042 for trail',
  project_slug: 'trail',
  session_id: parentSessionId,
  parent_run_id: parentRunId,
  tags: { feature_number: 'F042', model_tier: 'smart' },
}, async (ctx) => {
  ctx.recordToolCall('Read');
  ctx.recordToolCall('Edit', { error: true });

  const response = await anthropic.messages.create({ ... });
  ctx.recordTokens(response.usage);
  ctx.setResponseExcerpt(response.content[0].text);

  return response;
});

// Pattern 2: Anthropic SDK wrapper (auto-instrument)
const anthropic = wrapAnthropic(rawAnthropic, {
  project_slug: 'sanne',
  agent_kind: 'chatbot',
  agent_name: 'eir',
});
// All anthropic.messages.create() now auto-recorded as agent_runs

// Pattern 3: External event (for cc sessions managed by buddy)
import { recordAgentRun } from '@upmetrics/agent';

await recordAgentRun({
  project_slug: 'trail',
  agent_kind: 'cc',
  agent_name: 'cc-session-abc123',
  task: 'Fix F149.5 bake-off',
  session_id: 'buddy-session-abc',
  status: 'success',
  started_at: ..., ended_at: ...,
  input_tokens: 12345, output_tokens: 678,
  cost_usd: 0.42,
  tool_calls: [{ name: 'Read', count: 12 }, { name: 'Edit', count: 4 }],
});
```

### Buddy integration

Buddy ved allerede hvilke cc-sessioner der kører, deres tmux pane, deres input/output. Buddy bliver derfor den naturlige bridge for cc-agent-telemetri:

- Når en cc-session starter via buddy → POST `start` til Upmetrics, gem `run_id` på session
- Når cc afslutter (kill, finish, max_turns) → POST `finish` med duration, status, og hvis muligt token-tal fra cc's session metadata
- Tool calls kan trækkes fra cc transcript hvis vi parser dem (P2)

Dette er en separat integration der laves som del af buddy, ikke Upmetrics core. Upmetrics tilbyder bare API'et.

### Cardmem integration

`cardmem_dispatch_card` spawner cc-agenter. Når dispatch sker:
- cardmem POSTer agent_run start til Upmetrics med `agent_kind=subagent`, `parent_run_id` hvis nestet
- Når `cardmem_report_agent_status` modtages → opdater Upmetrics
- Når `cardmem_kill_agent` kaldes → marker som `abandoned`

Detaljeret schema i `docs/AGENT-SCHEMA.md`.

---

## 9. Remediation Webhook (Decoupled by Design)

Upmetrics fyrer ikke kommandoer, spawner ikke processer, kører ikke kode. Den **kalder webhooks**. Det er hvad der gør den lille og sikker.

### Trigger conditions
- Incident opens with severity ≥ configured threshold (default `medium`)
- Project har konfigureret `remediation_webhook_url`

### Webhook payload

```json
{
  "incident_id": "inc_01H...",
  "project": "trail",
  "kind": "probe_down",
  "severity": "high",
  "title": "trail.broberg.ai unreachable for 3 minutes",
  "opened_at": "2026-05-27T10:23:00Z",
  "trigger": {
    "type": "probe",
    "probe_id": "prb_...",
    "probe_name": "trail-prod",
    "target": "https://trail.broberg.ai/health",
    "consecutive_failures": 3,
    "last_error": "ECONNREFUSED"
  },
  "context": {
    "recent_errors": [/* last 5 issues with new events in window */],
    "recent_deploys": [/* recent releases */],
    "recent_agent_runs": [/* if relevant */]
  },
  "remediation_token": "rmd_..." // for callback authentication
}
```

### Receivers (examples, all configurable per project)

1. **cardmem** — `POST cardmem.../mcp/dispatch-from-incident` → creates a card, dispatches cc agent
2. **cc-spawn tool** (future) — direct cc spawn with incident context as initial prompt
3. **App self-heal callback** — app's own `/admin/upmetrics-callback` endpoint, e.g. trigger a re-deploy or restart
4. **Discord** — simple notification with action buttons (manual route)

### Callback (optional)
The receiver can POST back to `/api/incidents/{id}/remediation-callback` with status updates:
```json
{
  "remediation_token": "rmd_...",
  "status": "in_progress" | "succeeded" | "failed",
  "message": "cc agent fixed config in deploys/prod.yaml, redeployed"
}
```
This is logged to `incidents.remediation_attempts` and visible in the dashboard timeline.

Detaljeret kontrakt i `docs/REMEDIATION.md`.

---

## 10. cronjobs.webhouse.net Integration

Vi tilføjer en lille API til cronjobs.webhouse.net (eller bruger eksisterende job-API) så Upmetrics kan:

- `POST /api/jobs` — opret periodisk HTTP-check job
- `PATCH /api/jobs/{id}` — opdater interval / target
- `DELETE /api/jobs/{id}` — fjern

Hver job har én opgave: HTTP GET (eller TCP connect / SSL check) til target, og POST resultat til Upmetrics webhook.

Hvis cronjobs allerede har en generel "scheduled HTTP request" job-type, så bruger vi den. Hvis ikke, tilføjer vi den som en del af Upmetrics-arbejdet — det er en lille ændring i cronjobs codebase.

**Authentication:** Upmetrics kalder cronjobs med Bearer token. cronjobs kalder Upmetrics tilbage med HMAC-signed payload.

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Runaway ingest fra én klients buggy app fylder DB | F18 rate limiting + storage cap per projekt fra dag ét. Drop med advarsel når overskredet. |
| Upmetrics går ned uden at nogen ved det | F19 dead-man's-switch via cronjobs til separat Discord-kanal. |
| GDPR — kunders brugerdata i events (URLs, request bodies) | PII scrubbing i SDK før send (drop `Authorization`, mask emails, mask CPR, mask telefon). Per-projekt retention. `compliance_mode` flag disabler prompt/response excerpts. |
| FysioDK / sundhedssektor: Upmetrics-nedbrud bliver compliance-fejl | F22 — appen ejer sin egen audit log som primary record. Upmetrics er kun operationel kopi. Klart dokumenteret i `docs/SDK-FYSIODK.md`. |
| Capacitor native crashes vises som rå adresses (ikke symboliseret) | Acceptér i Phase 1. Symbolication-endpoint + dSYM/ProGuard upload er Phase 2. Native crash-tal er stadig korrekte, bare ikke pænt læsbare. |
| Tidsbudget — Christian er solo med mange projekter | Phase 1 scope er bevidst lille. Drop logs, drop session replay, drop traces. cronjobs genbrug. bun:sqlite på fly.io volume — ingen managed DB at vedligeholde. |
| Symbolication / source maps for produktion JS | Phase 1: gem stack frames som de kommer. Phase 2: source map upload + symbolication. Acceptér rå minified traces til start. |
| Agent monitoring schema låser sig fast for tidligt | `schema_version` field, fleksible `tags` + `tool_calls` jsonb. Tilføj kun strukturerede felter når mønstret er tydeligt. |
| Bygger noget jeg ikke faktisk bruger | MVP-første-bruger: trail + cms + WHop + Sanne + 1 Capacitor-app. Hvis ikke deployed i alle 5 inden Phase 1 close, så har jeg overengineered. |

---

## 12. Phase 1 Milestones (10 uger, deltids)

> Antagelse: ~10 timer/uge på sidetid vs. Subaio + WebHouse maintenance. Hvis mere tid → komprimer.

### Uge 1 — Foundation
- Monorepo skelet (pnpm + Turbo, alle 5 packages tom)
- Drizzle schema + migrations
- Hono server skelet + auth (Better Auth magic link)
- Reservér `upmetrics.org` + `.net` + `.io`
- `docs/ENVELOPE-SPEC.md` skrevet

### Uge 2 — Ingest core
- F02 Envelope ingest endpoint
- F03 Error grouping (basic fingerprint)
- F04 Agent run ingest endpoint
- Manuelt test med `curl`-payloads
- `docs/AGENT-SCHEMA.md` skrevet

### Uge 3 — SDK MVP
- F20 `@upmetrics/sdk` TS/JS — `init`, `captureException`, auto-instrument
- F05 `@upmetrics/agent` — `agentRun`, `wrapAnthropic`
- PII scrubbing baseline (Authorization headers, email/CPR/phone patterns)
- Self-host SDK i Upmetrics selv (dogfood fra dag ét)

### Uge 4 — Probes + Capacitor verification
- F06 Probe definitions + cronjobs.webhouse.net job sync
- F07 Probe result ingest
- Test mod 5-10 reelle WebHouse-sites
- Tilføj `scheduled HTTP probe` job-type til cronjobs hvis den ikke findes
- **F21 Capacitor verification:** point `@sentry/capacitor` mod Upmetrics i én Capacitor-app i drift, verificér at JS-fejl + native crashes (test-trigger) lander i issues

### Uge 5 — Dashboard skeleton
- Vite + Preact + Tailwind v4 + shadcn setup
- F11 Overview page (project cards)
- F16 Auth integration
- Navigation, layout, dark mode

### Uge 6 — Issues UI
- F12 Issues list + detail
- Stack trace renderer
- Filters, search

### Uge 7 — Agents UI
- F13 Agents list + detail + session view
- Cost aggregates (per project, per day)
- Hook buddy ind: send cc-session start/finish events

### Uge 8 — Probes UI + Incidents
- F14 Probes grid + detail + history chart
- F08 Incident correlation engine
- F15 Incidents view

### Uge 9 — Alerts + Remediation + Audit-mønster
- F09 Alert rules + Resend + Discord
- F10 Remediation webhook dispatcher
- Integrér cardmem som remediation target
- F19 Dead-man's-switch
- **F22 Audit log helper:** `return_audit_record`-mode i `agentRun`, `compliance_mode`-flag på `init`, dokumentation til FysioDK-integration i `docs/SDK-FYSIODK.md`

### Uge 10 — Polish + deploy
- F17 Retention/compaction
- F18 Rate limiting
- Deploy til fly.io (volume til sqlite, secrets via fly secrets, custom domæne)
- Migrér 5 første projekter (trail, cms, sanne, WHop, cronjobs) fra ingenting → Upmetrics
- README + CLAUDE.md færdig

---

## 13. Open Decisions

Disse skal afklares før udvikling går i gang. Christian beslutter.

1. **Primært domæne: upmetrics.org, .net, eller .io?**
   - .org: billigst ($7.50/$10.13), passer "open source-agtigt" feel (selv internt)
   - .io: kanonisk for dev tools, ledigt og kan registreres via CF
   - .net: $11.86 flat
   - **Anbefaling:** `upmetrics.io` som primær (kanonisk dev-tool TLD), `.org` + `.net` som forwards.

2. **Skal vi versionere agent_run schema fra dag 1?**
   - Add `schema_version` field nu → fremtidige ændringer er rene
   - **Anbefaling:** Ja, billigt at tilføje nu. (Allerede i schema.)

3. **Tjenester der ikke har CC kører — hvordan får vi telemetry?**
   - Eir-chatbot (Sanne) → `wrapAnthropic`
   - cctalk → instrumentér Hono-relay
   - Quick Capture (trail F182) → instrumentér ingest path
   - **Anbefaling:** SDK adoption skal være eksplicit per projekt, ikke automatisk.

4. **Remediation webhook — single URL per projekt eller liste med routing rules?**
   - Single URL: simpelt, kan altid være en router der dispatcher
   - Liste: mere fleksibelt, mere kompleksitet
   - **Anbefaling:** Single URL i Phase 1. Brug cardmem eller en simpel router-app hvis du har brug for routing.

5. **Skal session replay komme senere?**
   - Phase 2-spørgsmål, men design data model nu så det ikke blocker
   - **Anbefaling:** Ignorer i Phase 1, men hold `attachment` envelope item-type åben for fremtidige uploads.

6. **FysioDK-projekt timing vs Upmetrics Phase 1?**
   - Hvis FysioDK skal i drift før Upmetrics er klar: FysioDK-appen skriver til sin egen audit log fra dag ét uanset hvad. Upmetrics-telemetri kan tilføjes senere uden ændring i compliance-posture.
   - Hvis Upmetrics Phase 1 er klar først: aktivér `compliance_mode` + `return_audit_record` ved FysioDK-launch.
   - **Anbefaling:** Lav F22 helper'en tidligt i Uge 9 så den er klar uafhængigt af om FysioDK lander før eller efter. Det er <50 LOC når SDK fundamentet er på plads.

7. **Capacitor SDK versionering?**
   - `@sentry/capacitor` skifter version ofte. Vi skal teste mindst én version som "supported" og dokumentere den.
   - **Anbefaling:** Pin én Sentry Capacitor major-version som testet (fx v1 eller v2 alt efter hvad der er current). Opgradér eksplicit, ikke automatisk.

---

## 14. Definition of Done — Phase 1

Phase 1 er færdig når:

- [ ] Alle 22 features (F01-F22) er implementeret og deployed
- [ ] Mindst 5 projekter sender data: trail, cms, WHop, Sanne, cronjobs
- [ ] Mindst 10 probes kører aktivt via cronjobs.webhouse.net → Upmetrics
- [ ] Mindst 1 cc-session er logget end-to-end via buddy → Upmetrics
- [ ] Mindst 1 simuleret incident har triggered remediation webhook successfully
- [ ] Dead-man's-switch verificeret ved manuelt at stoppe Upmetrics i 10 min → Discord alarm modtaget
- [ ] Christian kan svare på 5 af 6 "use case" spørgsmål fra §8 via dashboard
- [ ] Sentry CLI test: `npx @sentry/cli send-event` mod Upmetrics endpoint → event vises i issues
- [ ] **Capacitor verification:** mindst 1 Capacitor-app i drift sender JS- og native crashes til Upmetrics via `@sentry/capacitor`
- [ ] **FysioDK pattern dogfood:** `agentRun` med `return_audit_record: true` testet end-to-end mod en test-app der persisterer audit record lokalt + sender til Upmetrics

---

## 15. Future (Phase 2+, ikke besluttet)

- Logs (struktureret, evt. ClickHouse hvis volumen kræver det)
- Distributed tracing / spans
- Session replay
- Source map upload + symbolication
- Release health (sessions, crash-free %)
- Public status pages per projekt
- AI-drevet incident summarization
- Multi-tenant hvis det nogensinde åbnes op for andre
