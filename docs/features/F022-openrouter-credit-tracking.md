# F022 — OpenRouter credit-tracking + Upmetrics export-API

> **Goal:** Upmetrics becomes the canonical source for OpenRouter credit/balance
> data and exposes its *own* read-API, so consumers like **Cardmem** can build a
> usage dashboard without knowing OpenRouter. Upmetrics owns the polling, the
> history and the threshold alarms; Cardmem only reads.
>
> Source plan: Christian, 2026-06-28 (UPMETRICS-OPENROUTER-CREDITS-PLAN.md).

## 1. Problem

OpenRouter spend is only visible by logging into their dashboard or calling their
API ad-hoc. No history, no threshold alarm, no shared source the rest of the
ecosystem can read. An account without auto top-up just fails with `402` at zero
balance — with no warning *before* it happens. We do not want every repo polling
OpenRouter itself (rate limits, key sprawl, no shared history). Upmetrics is
already the canonical cost-sink for `agent_runs`, so it is the natural place to
also collect **provider balance** (the money figure OpenRouter owns), so Cardmem
can show "spent / bought / remaining" live.

## 2. Solution overview

```
OpenRouter /api/v1/credits ──┐ (poll, scheduled probe)
                             ▼
            UPMETRICS: credit_snapshots (history) · latest-balance view
                       · threshold alarms → Discord/webhook · agent_runs (spend)
                             │  Upmetrics' OWN read-API (Bearer, scoped)
                             ▼
            Consumers: Cardmem dashboard · other repos
```

Two complementary, separate data flows:
1. **Provider balance (money)** — OpenRouter's own truth (bought/used/remaining),
   polled periodically → snapshots in Upmetrics.
2. **Actual spend (runs)** — already covered by `agent_runs` via `@broberg/ai-sdk`'s
   upmetrics sink. Explains *where* the money went (per model/project/day), but is
   not the money source.

The Cardmem panel combines the two: the money number from snapshots, the
breakdown from `agent_runs`.

## 3. v1 scope decisions (resolving the plan's open questions)

Sensible defaults matching the plan's own recommendations — Christian can override:
- **Management key** → Upmetrics Fly secret `OPENROUTER_MANAGEMENT_KEY`, injected
  into the probe payload at registration (fewer places the key lives). Never hardcoded.
- **Granularity** → account-level only in v1. Per-API-key (`/api/v1/key`) deferred.
- **Multi-provider** → schema is multi-provider (`provider` column) from day one;
  only the OpenRouter adapter ships in v1.
- **Credit-expiry warning** → out of v1 (needs purchase date, which `/credits` does
  not return). Low-balance + burn-rate alarms only.
- **Ship dark** → the whole feature is inert until `OPENROUTER_MANAGEMENT_KEY` is
  set: no probe registered, no crash, no half-wired surface.

## 4. Boundaries / non-goals

- **Upmetrics owns** the polling, history, alarms and the money source.
- **Cardmem owns only** the display — it never polls OpenRouter.
- **`agent_runs` stays the run/spend source, never the balance source** — the two
  are never conflated.
- `wrapAnthropic` / call instrumentation in `@broberg/ai-sdk` is untouched — this is
  a new parallel data stream (provider balance), not call instrumentation.
- Upmetrics **never executes commands** — critical alarms relay to Discord + a
  generic webhook so a consumer/cc-spawn can react (existing remediation pattern).

## 5. Story breakdown

| Story | Title | Depends on |
|---|---|---|
| F022.1 | `credit_snapshots` data model + latest-balance view | — |
| F022.2 | Credit-snapshot ingest endpoint | F022.1 |
| F022.3 | `provider_balance` probe-kind + OpenRouter adapter (ship-dark) | F022.1, F022.2 |
| F022.4 | Threshold alarms + burn-rate | F022.1 |
| F022.5 | Export-API (read-only, scoped Bearer tokens) | F022.1, agent_runs |

Each story carries testable acceptance criteria on its card. The **Cardmem usage
panel** (three numbers + remaining-gauge + history graph + "empty in N days" +
breakdown) is the consumer surface and is **Cardmem's** to build against the
F022.5 contract — handed off via intercom when the export-API lands, not an
Upmetrics story.

## 6. Data model (F022.1)

```ts
// credit_snapshots — append-only history
{ id, provider, total_credits, total_usage, remaining, currency, captured_at, raw }
```
`provider` makes it multi-provider from day one. "Latest state" is
`SELECT … WHERE provider=? ORDER BY captured_at DESC LIMIT 1` — a view/helper, not
a separately-synced table.

## 7. Export-API (F022.5)

| Endpoint | Returns |
|---|---|
| `GET /api/v1/providers/:provider/balance` | latest snapshot (credits/usage/remaining/captured_at) |
| `GET /api/v1/providers/:provider/balance/history?from&to&granularity` | snapshot time-series |
| `GET /api/v1/providers/:provider/burn-rate` | spend/day + estimated "empty in N days" |
| `GET /api/v1/usage/breakdown?provider&from&to&group_by=model\|project\|day` | breakdown from agent_runs |
| `GET /api/v1/providers/:provider/alarms` | current threshold state (ok/warn/critical) for the badge |

Scoped read-only Bearer tokens: a consumer token reads, never writes probes/alarms.
Responses are pure JSON; no OpenRouter detail leaks (swap provider → dashboard unchanged).

## 8. Rollout

Ship-dark behind `OPENROUTER_MANAGEMENT_KEY`. Order: F022.1 → F022.2 → F022.3 →
F022.4 → F022.5. Verify alarms with an artificial low snapshot (mock); verify the
export-API shapes with tests; Cardmem Lens-verifies its own panel. Notify Cardmem
when F022.5 is live so they card + build the panel.

## 9. Open questions for Christian

The v1 decisions in §3 are reversible defaults. Flag if you want any changed:
per-key granularity in v1, full multi-provider adapter abstraction now, or
credit-expiry warnings (would need a manual purchase-date source).
