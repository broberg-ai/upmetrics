# F003 — SDKs (JS/TS, Agent, Capacitor, Compliance)

> Tier: high · Effort: L (Uge 3 + parts of 4/9) · Status: planned

## Motivation

Ingest endpoints (F002) are inert without clients that produce events. The plan's differentiator is **first-class AI agent monitoring** (§8) plus zero-friction error capture via Sentry compatibility. This epic ships the client libraries: a general error SDK, the agent-telemetry SDK, Capacitor support, and the compliance helper that lets regulated apps (FysioDK) keep their own audit log while sending sanitized telemetry.

## Solution

Four related libraries: `@upmetrics/sdk` (errors, auto-instrument, PII scrub), `@upmetrics/agent` (agentRun/wrapAnthropic/recordAgentRun), Capacitor via the official `@sentry/capacitor` pointed at upmetrics, and the `return_audit_record` + `compliance_mode` helper in `@upmetrics/agent`.

## Scope

### In scope
- **F20 `@upmetrics/sdk`:** `init`, `captureException`, `captureMessage`, `setUser/setTag/addBreadcrumb`; auto-instrument `window.onerror`, `unhandledrejection`, fetch; PII scrubbing (drop Authorization/Cookie, mask email/CPR/phone).
- **F05 `@upmetrics/agent`:** `agentRun(meta, fn)` lifecycle wrapper, `wrapAnthropic(client, opts)` auto-instrument, `recordAgentRun(...)` external one-shot; `ctx.recordToolCall/recordTokens/setResponseExcerpt`.
- **F21 Capacitor:** verify envelope parser handles all `@sentry/capacitor` item types; test against one in-production Capacitor app (JS + native crash). Pin one tested Sentry-Capacitor major.
- **F22 Compliance helper:** `return_audit_record:true` returns structured-only payload; `compliance_mode:true` force-disables excerpts + tags `compliance:'gdpr-health'`.
- `docs/SDK-CAPACITOR.md`, `docs/SDK-FYSIODK.md`.

### Out of scope
- iOS dSYM / Android ProGuard symbolication (Phase 2 — native crashes show raw addresses).
- Buddy/cardmem integrations that CALL these SDKs (those live in buddy/cardmem repos, not here).
- Server-side ingest changes (F002 owns the endpoints).

## Architecture (PLAN §8)

### @upmetrics/sdk
Transport posts Sentry-format envelopes to F002's endpoint. Scrubbing runs in a pre-send hook. Framework-agnostic core + thin browser/node entry points.

### @upmetrics/agent
`agentRun` opens a run (`start`), runs `fn(ctx)`, closes it (`finish`) with tokens/cost/tool_calls. `wrapAnthropic` proxies `messages.create`. `recordAgentRun` posts a completed run for externally-managed sessions (e.g. buddy-managed cc).

### Capacitor (F21)
No custom native code: `@sentry/capacitor` with `dsn` = upmetrics DSN. We only verify the envelope parser (F002) accepts its item types and document `init` config.

### Compliance (F22)
One code path, two outputs: upmetrics gets fire-and-forget telemetry; the app gets a synchronous structured `auditRecord` to persist in its own legally-binding log. Helper never returns or sends cleartext user data.

## Stories
- **F003.1** — @upmetrics/sdk core: init/capture/auto-instrument/PII-scrub.
- **F003.2** — @upmetrics/agent: agentRun + wrapAnthropic + recordAgentRun.
- **F003.3** — Capacitor verification against a real app + SDK-CAPACITOR.md.
- **F003.4** — Compliance helper (return_audit_record, compliance_mode) + SDK-FYSIODK.md.

## Acceptance criteria
1. `@upmetrics/sdk` captures + auto-instruments in browser+node+bun; PII scrubbing verified (Authorization dropped, email/CPR/phone masked).
2. `agentRun`/`wrapAnthropic`/`recordAgentRun` each produce a correct `agent_runs` row.
3. A real Capacitor app lands a JS error AND a native crash in issues via `@sentry/capacitor`.
4. `return_audit_record:true` yields structured-only payload; `compliance_mode:true` disables excerpts + tags `compliance:'gdpr-health'`.
5. SDK-CAPACITOR.md + SDK-FYSIODK.md committed.

## Dependencies
- **F002** (ingest endpoints must exist to receive SDK output).
- **F001** (monorepo packages scaffold).

## Rollout
Ship `@upmetrics/sdk` first and dogfood inside upmetrics. Then `@upmetrics/agent`. Capacitor + compliance verified last (Uge 4 / Uge 9 in PLAN). Each library independently publishable within the monorepo.

## Open Questions
- Which Capacitor app is the verification target (PLAN §13.7) — most-active in-production app; Christian picks.
- Sentry-Capacitor major version to pin (PLAN §13.7).

## Effort estimate
**L** — spans Uge 3 (SDK MVP) + Uge 4 (Capacitor) + Uge 9 (compliance helper).
