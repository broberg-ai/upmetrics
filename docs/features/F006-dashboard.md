# F006 — Dashboard

> Tier: high · Effort: L (Uge 5–8) · Status: planned

## Motivation

All the ingest, grouping, probes, and incident machinery is invisible without a UI. The plan's core promise — "ét sted at se helbredet af alle Christians sites, apps og services" — is the dashboard. The **Agents** view in particular (§8) is the differentiator over GlitchTip: cost, session traces, tool-failure analytics for cc/cardmem/Eir/cctalk.

## Solution

A Vite + Preact + Tailwind v4 + shadcn SPA with five surfaces — Overview, Issues, Agents, Probes, Incidents — gated by the Better Auth session from F001, reading the read-side of the F002–F005 data.

## Scope

### In scope
- **F11 Overview:** per-project health card (probe up%, open issues, agent cost today, open incidents) + global health matrix.
- **F12 Issues:** list/filter/search/group; detail = stack trace, breadcrumbs, tags, occurrence timeline, related agent runs; actions resolve/ignore/assign/link-to-GitHub.
- **F13 Agents:** runs list w/ filters; aggregates (cost per project/day, runs per agent_name, success rate, p95 duration); detail w/ tool-call timeline + token breakdown; session view by `session_id`.
- **F14 Probes:** grid w/ up/down + response sparkline; detail history chart + last failure; pause/resume/edit/delete (delete cascades to cronjobs removal via F004).
- **F15 Incidents:** open-incidents bar on every page; detail timeline + trigger events + remediation attempts; acknowledge/resolve/manual-remediate.
- **F16 (UI):** wire Better Auth session into the SPA; login screen; route guards.

### Out of scope
- Any new read API shapes beyond what F002–F005 expose (add thin read endpoints as needed, but business logic stays server-side).
- Session replay / trace waterfalls (Phase 2).

## Architecture (PLAN §3, §8)

### Stack
Vite 5 + Preact 10 + Tailwind v4 (CSS-first `@theme` tokens) + shadcn/ui + Recharts. Custom `components/ui` for Modal/Select/DatePicker (no native controls).

### Data
SPA calls `apps/server` read endpoints. Agents view leans on `agent_runs` columns (`purpose`/`provider`/`tier` are first-class for filtering, per PLAN §5).

## Stories
- **F006.1** — SPA shell: Vite+Preact+Tailwind+shadcn, layout, dark mode, auth wiring (F16), custom UI primitives.
- **F006.2** — Overview (project cards + global matrix).
- **F006.3** — Issues (list + detail + stack-trace renderer).
- **F006.4** — Agents (list + aggregates + session view).
- **F006.5** — Probes (grid + history) & Incidents (bar + detail + actions).

## Acceptance criteria
1. Overview renders per-project health card + global matrix from live data.
2. Issues list filters/searches; detail renders stack trace + breadcrumbs + related agent runs; resolve/ignore/assign work.
3. Agents view answers the §8 use cases (cost/project/day, failed runs, session trace, tool-failure rates, long-running detection).
4. Probes grid + history chart; Incidents bar + timeline + acknowledge/resolve/manual-remediate.
5. Auth gates the SPA; dark mode + custom UI controls throughout (no native dialogs/selects/date-pickers).

## Dependencies
- **F001** (auth, web workspace).
- **F002** (issues/agents data), **F004** (probes data), **F005** (incidents data).

## Rollout
Shell+auth first, then Overview, Issues, Agents, then Probes+Incidents (PLAN Uge 5–8). Each surface ships independently behind the same shell.

## Open Questions
- None blocking. GitHub-issue linking depth in F12 can start as a simple URL link and deepen later.

## Effort estimate
**L** — Uge 5–8 in PLAN §12 (four surfaces).
