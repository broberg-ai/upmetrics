# F011 — Mobile-friendly dashboard (usable in a mobile browser)

> Open questions (resolve before building Phase 1):
> 1. **Nav pattern** — bottom tab bar (thumb-reach, 6 items: Overview/Issues/Agents/Probes/Incidents/Remediation fits) vs hamburger off-canvas drawer? Recommendation: **bottom tab bar**.
> 2. **Scope of parity** — full action parity on mobile (recommended) vs read-only triage view?
> 3. **What is "sygt langsomt" concretely** — is it first-load (bundle/parse) or in-app navigation/data fetch? Phase 0 measures this before we optimize.
> 4. **PWA / add-to-home-screen** — in scope (installable, offline shell) or out? Proposed as a stretch story.

## Motivation
The fleet is now fully instrumented (F009 dogfood, F010 remediation, fleet probes + alerts). The natural next need is checking it **from a phone** — but the dashboard is desktop-first and Christian reports it "sygt langsomt" on mobile. Measured 2026-05-31: the **server is not the bottleneck** (`/` 229ms, `/health` 78ms live from prod). The cost is client-side:
- A fixed `w-56` left sidebar (`components/Layout.tsx`) eats ~150px of a 375px screen.
- Wide `<table>`s overflow horizontally (Issues, Remediation history, Overview "Global matrix", Agents runs).
- ~460KB initial JS (130KB gzip) parsed up-front on a mobile CPU.

## Non-goals
- No parallel mobile codebase or duplicate routes — responsive refactor of existing components.
- No backend/API changes — purely `apps/web` presentation + bundle splitting.
- Not a native app (the SDK already covers native fleet apps; this is the admin dashboard in a mobile browser).

## Architecture sketch
Vite + Preact + Tailwind v4 SPA. Use Tailwind breakpoints (`sm:`/`lg:`) to adapt the existing components — no new layout engine.

## Stories

### F011.1 — Responsive app shell
`components/Layout.tsx`: below `lg`, hide the fixed sidebar; render a **bottom tab bar** (icons from the existing `NAV` array) + make `<main>` full-width. `IncidentsBar` stays pinned. Ensure `<meta name=viewport>` in `index.html`. Active-route highlight carries over.

### F011.2 — Mobile data layouts
The overflowing tables become stacked **card rows** under `sm`:
- `routes/Issues.tsx` (issues table) + the detail `Modal` → full-screen sheet on mobile.
- `routes/Remediation.tsx` (History table).
- `routes/Overview.tsx` ("Global matrix" table — the project cards grid is already responsive; verify).
- `routes/Agents.tsx` (runs table + aggregates).
Pattern: `hidden sm:table` for the table, a `sm:hidden` stacked-card list for narrow screens, sharing the row data.

### F011.3 — Touch & density pass
Tap-target sizing (≥44px), filter `CustomSelect`/search usable on small screens, `ProjectDetail` component drill-down + `Probes` grid spacing, issue-detail action buttons wrap cleanly. Reuse `controls.tsx` primitives; keep house-rule feedback (`:active`/`:hover`/loading).

### F011.4 — Perf: route-level code-splitting (the "slow" fix)
Lazy-load route components in `App.tsx` (`preact/compat` lazy + Suspense or dynamic import) so the initial bundle is the shell + first route only. **Phase 0 first**: measure mobile load on a throttled profile (4x CPU, slow-4G) to confirm the bottleneck is first-load vs data-fetch; prioritize from the number, don't guess (lesson from the FDS Lighthouse-desktop-preset blind spot).

### F011.5 (stretch) — PWA / installable
Manifest + service worker for add-to-home-screen + offline shell, IF Christian wants it. Decide via open question 4.

## Verification
Per the PWA-verification gotcha: verify on a real mobile viewport (device emulation + DB-confirmed runtime), not desktop devtools alone. Capture before/after mobile load numbers for F011.4.

## Rollout
Ship per story behind the existing deploy (fly app `upmetrics`, arn). Each story is independently deployable; UI changes need Christian's visual sign-off (Review).