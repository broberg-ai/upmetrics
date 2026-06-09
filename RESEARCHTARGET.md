# Machine-readable header — the Research Adapter worker reads this to ROUTE + PRE-FILTER
# (YAML tokens + prose). The prose below is what THIS repo's cc session reads when it
# receives a research task, so it can judge fit fast without spending startup tokens.
slug: upmetrics
name: Upmetrics — fleet error-tracking + AI-cost telemetry + uptime/deploy observability
stack: [bun, hono, drizzle, bun-sqlite, litestream, better-auth, preact, vite, tailwind-v4, fly, upmetrics-sdk]
research_interests:
  - observability-telemetry        # error tracking, fingerprinting, incident correlation
  - llm-cost-tracking              # per-agent/tenant/model attribution, micro-USD accounting
  - sqlite-at-scale                # bun:sqlite, WAL tuning, Litestream durability
  - alerting-incident-systems      # dedup, escalation tiers, storm control
  - uptime-probing                 # HTTP/TCP/keyword/SSL checks + escalation
  - deploy-ci-observability        # CI watching, release registry, deploy-event relay
  - error-grouping-fingerprinting
  - fly-ops-resilience             # single-instance flap avoidance, WAL/Litestream
not_interested:
  - frontend-marketing-design      # sanneandersen / cms territory
  - e-commerce-payments
  - cms-content-modelling
  - llm-prompt-engineering         # we're the cost SINK, not an LLM-feature builder — ai-sdk territory
landing_path: docs/research/
---

# Upmetrics — Research Target

> You (upmetrics' cc session) just received a **research task**: an article aimed at upmetrics.
> Read this to orient WITHOUT spending startup tokens, then judge the article against upmetrics
> and land your research per "How to land your research" below.

## What I am
A fleet **observability platform** — the single place that answers "is the fleet healthy, what's broken, and what is the AI costing?" Three tracks: (1) **error tracking** (Sentry-like: an SDK captures errors → deduped issues → incidents), (2) **AI-cost telemetry** (every fleet repo's LLM/agent runs land here via `@broberg/ai-sdk`'s upmetricsSink → per-agent/per-tenant cost), (3) **uptime + deploy observability** (probes, CI watching, deploy-event registry + relay). I **observe / report / relay only** — I never execute deploys or remediations.

## What I do
- Ingest errors via **DSN** (`@upmetrics/sdk`) → fingerprint → group into issues → correlate into incidents.
- Ingest AI-cost via project **api-key** (`X-Upmetrics-Key`) → `agent_runs` → per-agent/tenant/model cost (integer micro-USD).
- Run uptime **probes** (HTTP/TCP/keyword/SSL) via a cronjobs HTTP-trigger → tiered escalation → Discord/email alerts.
- **Watch** GitHub Actions CI + observe **deploy-events** (release registry + a pull-feed relay back to the launching session).
- Push remediation-eligible incidents to cardmem's Inbox (pull-feed; buddy relays to live cc sessions).

## Stack
Bun · Hono · Drizzle + `bun:sqlite` (WAL, Litestream replication to Tigris/S3) · Better Auth (magic-link allowlist) · Vite + Preact dashboard (Tailwind v4) · Fly.io (single `arn` instance) · `@upmetrics/sdk` (published via CI/OIDC).

## Key concepts (where an idea would plug in)
- **Dual-auth** — DSN (public, error-capture) vs `uk_` api-key (secret, cost-ingest): two separate tracks.
- **Issue grouping / fingerprinting**; **incident correlation** (error-spike, agent-failure-spike, probe-down).
- **Alert engine** — per-rule dedup, a higher severity breaks dedup (escalation re-alerts), storm control (fleet roll-up + rate-limit digest).
- **Cost model** — integer micro-USD, round-once-at-boundary, tag-based per-tenant slicing, idempotency-key upsert for re-pushed daily aggregates.
- **Pull-feed relay** — upmetrics is cloud, buddy is Tailscale-local → upmetrics NEVER pushes; it exposes feeds buddy polls (remediation + deploy-complete).
- **Probes** via cronjobs scheduler · **deploy-events** observe (F019) · **Lens mint-endpoint** (real Better-Auth session for read-only visual verification).

## Research interests — judge the article against THESE
Observability + telemetry (error tracking, fingerprinting, incident correlation) · LLM cost tracking + attribution (per-tenant/agent/model, micro-USD) · SQLite at scale (`bun:sqlite`, WAL, Litestream durability) · alerting / incident systems (dedup, escalation, storm control) · uptime probing · deploy/CI observability + release registries · Fly.io single-instance resilience.
**NOT relevant:** marketing / frontend design, e-commerce, CMS content-modelling, LLM prompt-engineering for content generation (we are the cost SINK, not an LLM-feature builder — route those to ai-sdk).

## Current focus (timely research lands best here)
- **F019 deployment-management** — deploy-event observe / release registry / pull-feed relay + GitHub Actions CI watching (live; integrating with trail + cms).
- **Cost-sink fidelity** — per-tenant cost slicing, dated-model pricing accuracy.
- **Resilience** — avoiding the single-instance flap; WAL / Litestream tuning (see `docs/adr/0001`).

## Hard constraints (any adopted idea MUST respect these)
- upmetrics **OBSERVES / REPORTS / RELAYS — it NEVER executes** deploys or remediations (the safety seam; ops/the originating session executes).
- Region is **ALWAYS `arn`** (Stockholm).
- `@upmetrics/sdk` publishes **ONLY via CI/OIDC** (`sdk-v*` tag) — never local `npm publish`.
- Any LLM feature here MUST route through **`@broberg/ai-sdk`** (we're the cost sink; never a direct provider).
- Money is **integer micro-USD**, rounded once at the boundary.
- `bun:sqlite` never runs an inline WAL checkpoint (Litestream owns it) — see ADR-0001 flap.
- No native dialogs/controls; no hardcoded values (one source, trickle down).

## How to land your research
Write `docs/research/<slug>.md` in THIS repo via the cardmem landing tool. The doc must answer:
1. **TL;DR** — the article in 2–3 lines.
2. **Relevance to upmetrics** — which track/concept above it touches + fit strength (high / med / low) and why.
3. **Adaptation** — concretely how the idea could land in upmetrics' stack (real files/concepts), respecting the Hard constraints.
4. **Next step** — a suggested card / experiment (or "file-and-forget" if low fit). This is the SDLC hand-off into the board.
