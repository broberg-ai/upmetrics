# F019 — Deployment Management (watch / report / relay)

> **Status:** Backlog. Re-homed from `components` (was F027; `move_card_to_project`
> renumbered it F019). **Scope LOCKED 2026-06-08 (Christian): upmetrics WATCHES,
> REPORTS, and RELAYS deployment state — it NEVER executes a deploy.** Same safety
> seam as remediation: ops (or the originating cc-session) executes; upmetrics
> observes and relays. Provider-deploy logic and the deploy-trigger UI were sent
> back to `components` (see Non-goals).

## Why

The fleet has ~19 LightSail/Fly apps and several PWAs. Today a deploy's outcome is
invisible until someone curls the site or watches `fly logs`. There is no single
surface that answers: *did the last deploy go GREEN, which CI run produced it, and
which cc-session should pick up the follow-on work?* upmetrics already owns fleet
observability (errors, cost, incidents, probes) — deployment state is the missing
column in that same picture. This epic adds it **as an observer**, reusing the
probe/escalation/AI-analysis machinery upmetrics already ships.

This fits the SDLC northstar: **Deploy Watcher → GREEN → ping the launching
cc-session so it picks up the next story.** upmetrics is the watcher and the relay;
it is never the deployer.

## Scope (observe / report / relay)

| Capability | What upmetrics does | What it never does |
|---|---|---|
| **Watch** | Poll Fly GraphQL (READ-only) for release/deploy status; poll GitHub Actions; ingest an SSE deploy bus | Trigger a deploy, run `flyctl`, push images |
| **Report** | Multi-service health probes + tiered escalation + Discord/email alert + AI error analysis; CI-runs viewer in the dashboard | — |
| **Relay** | On terminal deploy status, send exactly one buddy-intercom to the **originating** cc-session | Execute the follow-on work itself |
| **Registry** | `GET /release/:site → {version, sha, deployedAt}` from observed events; optional Web Push | Own the "reload" toast (that's the PWA shell, components) |

## Non-goals (sent BACK to components — execution side)

- **F019.1 deploy provider-core** — Fly HMAC incremental-sync, Cloudflare Pages, GitHub Pages deployers. Archived here; components recreates it on their side.
- **DeployModal** — any deploy-trigger UI. Removed from F019.5. Deploy-trigger surfaces live wherever execution lives (cms / whop), never in the observability dashboard.
- **Redis pub/sub for multi-instance SSE** — out of v1 scope; the bus is single-process and logs the limitation.

## Architecture seam

```
  cms / whop / fysiodk            upmetrics (THIS epic)              originating cc-session
  ─────────────────────          ──────────────────────             ──────────────────────
  run deploy (execute)  ──emit──▶  deploy-event { site, sha,                 ▲
                                     status, originator }                    │ buddy intercom
  Fly / GitHub Actions  ──poll──▶  Watch (GraphQL READ / Actions)            │ (1 per deploy-id)
                                     │                                       │
                                     ├─▶ Report: probes + escalation + AI ───┘
                                     ├─▶ Relay: on terminal status, ping originator
                                     └─▶ Registry: GET /release/:site (+ push)
```

The **`originator`** field on each deploy-event (which cc-session / repo launched
the deploy) is the routing key for the relay. Execution-side repos (cms/whop) MUST
stamp it, or the relay has nowhere to route — this is a cross-repo contract, tracked
in F019.7.

## Stories

Each story is independently shippable and Lens-verified before Done. Build order:
**core watcher first** (probe → health → CI → relay), registry/push after.

| # | Story | SP | Notes |
|---|---|---|---|
| F019.2 | Extract HTTP probe + escalation core | 3 | Builds on existing `probes.ts` (F004); 1/2/3-tier escalation |
| F019.3 | Multi-service health-check + AI analysis + Discord alert | 3 | AI analysis via `@broberg/ai-sdk` (no hardcoded model) |
| F019.4 | GitHub Actions CI module | 3 | Poll workflow runs; observe only |
| F019.5 | WorkflowRunsCard — CI runs viewer (Stack A) | 2 | Observe/report; **DeployModal removed** |
| F019.6 | DeployStatus Preact display component (Stack B) | 3 | Read-only status display |
| **F019.7** | **Deploy-complete relay → ping originating cc-session** | 3 | Idempotent (1 intercom / deploy-id, `relayed_at` stamp); **dep:** cms/whop stamp `originator` |
| **F019.8** | **Release registry `GET /release/:site` + optional Web Push** | 3 | Source of truth from observed events; reload-toast belongs to components PWA shell |

Carded total at kickoff: **14 SP** (F019.2–.6). F019.7 + F019.8 add **6 SP**.

## Dependencies

- **Fly GraphQL READ token** (release/deploy status) — read-only, within identity. Not flyctl execution.
- **F019.7 ⟸ execution-side `originator` stamp** — cms/whop must add `originator` (cc-session / repo) to every deploy-event they emit, or the relay can't route. Cross-session contract; intercoms #4140 / #4144 / #4147 / #4148.
- **F019.8 ⟸ components PWA shell (F021/F022)** — upmetrics owns the registry + push; the "new version — reload" toast is a custom (non-native) toast on the components side.
- AI analysis (F019.3) routes through `@broberg/ai-sdk` per the fleet AI policy.

## Rollout

1. Core watcher: F019.2 → F019.3 → F019.4 (probe/health/CI), each shipped + Lens-verified.
2. Relay: F019.7 once at least one execution-side repo stamps `originator`.
3. Viewers: F019.5 (Stack A) + F019.6 (Stack B).
4. Registry + push: F019.8 last.

Christian flips each story to **Ready** when he wants it picked up — one story at a time.
