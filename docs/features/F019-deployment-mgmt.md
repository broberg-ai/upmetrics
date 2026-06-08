# F027 — Deployment Management (watch/report/CI)

> L3 Domain · hybrid · effort **L** · impact **high** · owner `cms`. Status: Backlog.
> Graduate-candidate: YES — should get its own repo + cardmem project (recommendation, confirm with Christian).

## Motivation
A deployment-management toolkit covering three related concerns: (1) deploying built artefacts to hosting providers (Fly.io incremental-sync, Cloudflare Pages direct-upload, GitHub Pages), (2) watching running apps + CI pipelines in real time (Fly GraphQL sync, GitHub Actions workflow-run polling with live drill-down, SSE event bus for webhook-driven page-build events), and (3) reporting health across a fleet (HTTP/TCP probing with escalation tiers, multi-service API health checks with retry, Discord/email alerting, AI-generated error analysis). Every concern is already in production across multiple repos — the component captures the shared headless contract so each repo stops reimplementing the same probing/alerting primitives.

## Solution
**hybrid.** The provider adapters (Fly deploy, CF Pages, HMAC-signed sync, Fly GraphQL sync) are identical logic in cms + whop + partially cardmem/buddy → runtime package. The probing/alerting core (HTTP probe, escalation model, Discord webhook shape) is used in whop + cronjobs + upmetrics + fysiodk (>=3, stable). But the UI (DeployModal SSE reader, WorkflowRunsCard poll, health tab) is coupled to per-project design systems → copy-owned. So: headless engine (package) + copy-owned UI scaffolds per stack.

## Scope

### In scope
- Extract from `webhouse/cms` `packages/cms-admin/src/lib/deploy/{fly-live-provider,cloudflare-pages-provider,fly-machines,deploy-events}.ts` + `components/deploy-modal.tsx`.
- Headless deploy/probe/health/alert/ci modules + Stack A + Stack B UI scaffolds.

### Out of scope
- Per-project UI design + data models (copy-owned scaffolds).
- Multi-instance Redis SSE bus (v1 is single-process).

## Architecture

### Best source (reference implementation)
`webhouse/cms` — `packages/cms-admin/src/lib/deploy/`: HMAC-signed incremental Fly Live deploy (manifest diff + atomic commit), CF Pages direct-upload (idempotent project create), typed Fly Machines REST client, in-process SSE deploy-event bus; DeployModal shows the full SSE consumer (abort, progress steps, skip-dialog). Production-hardened, framework-agnostic core (node:crypto + fetch).

### Other implementations seen
- `webhouse/whop` `app/api/cron/{probe-quick,fly-sync}/route.ts` — HTTP probe escalation model (1 fail silent / 2 warning / 3 critical+alert, with alertSentAt guard) + Fly GraphQL app-sync.
- `webhouse/fysiodk-aalborg-sport` `developer/github-tab.tsx` + `lib/api-health-check.ts` — GitHub Actions workflow-run viewer (paged + live poll + job drill-down) + multi-service health (per-service timeout, transient-retry, Discord embed, Claude analysis).
- `webhouse/buddy` `apps/server/src/dispatch-scheduler.ts` — probe-then-dispatch (dot-path JSON extraction, dedup by stable id set, stale in-flight reclaim) — pendingPath/idsPath contract.
- `cbroberg/code-launcher` `src/app/api/probe/route.ts` — local port-probe (isHttpUp, lsof PID-on-port).

### Headless core vs. adapters
- **Core (no React/next):** deploy/fly-live (flyLiveDeploy, syncContent, diffManifests, signIcdRequest, generateSyncSecret); deploy/cloudflare-pages (cloudflarePagesDeploy); deploy/fly-machines (typed REST client); events/deploy-event-bus (subscribe/publish keyed by orgId:siteId + optional Web Push hook); probe/http (probeHttp → {httpStatus, responseTimeMs, error}); probe/escalation (applyEscalation 1/2/3 model from whop); health/multi-service (runAllChecks, withRetryOnTransient, analyzeWithClaude from fysiodk); alert/discord (sendDiscordAlert embed); ci/github-runs (fetchWorkflowRuns, fetchRunJobs).
- **Stack A (Next/React/shadcn):** route handlers expose SSE /api/deploy/stream + cron probe-quick/fly-sync + /api/admin/github/runs; copy-owned UI: DeployModal (SSE reader + 4-step progress + skip-dialog), WorkflowRunsCard + CommitsCard (paged + live-poll), HealthTab (service grid + latency badges). Only imports the core, never next/navigation.
- **Stack B (Bun/Hono/Preact):** Hono route group mounts the core; SSE via c.streamText(); scheduled health probes via buddy dispatch-scheduler (not Next cron); copy-owned Preact UI (signal-based). No next/server.

### Public API
```ts
export { flyLiveDeploy, flyLiveRebuildInfra, syncContent, diffManifests, signIcdRequest, generateSyncSecret } from './deploy/fly-live';
export { cloudflarePagesDeploy } from './deploy/cloudflare-pages'; export { FlyMachinesClient } from './deploy/fly-machines';
export { subscribe, publish, listenerCount } from './events/deploy-event-bus';
export { probeHttp } from './probe/http'; export { applyEscalation } from './probe/escalation';
export { runAllChecks, withRetryOnTransient, analyzeWithClaude, sendDiscordNotification } from './health/multi-service';
export { sendDiscordAlert } from './alert/discord'; export { fetchWorkflowRuns, fetchRunJobs } from './ci/github-runs';
```

## Stories
- **F027.1** — Extract + publish deploy provider core — _AC:_ exports flyLiveDeploy/cloudflarePagesDeploy/FlyMachinesClient/deploy-event-bus from cms source; cms imports the package + all deploy flows pass (smoke: flyLiveDeploy forceRebuildInfra=false → filesUnchanged>0 within 2s).
- **F027.2** — Extract HTTP probe + escalation core — _AC:_ probeHttp returns {httpStatus,responseTimeMs,error} within 5s for reachable domains; applyEscalation → 'critical' on the 3rd consecutive failure + 'none' on first two; whop probe-quick uses the primitive + produces identical alert behaviour.
- **F027.3** — Extract multi-service health check module — _AC:_ runAllChecks(['supabase_db','anthropic'], opts) runs in parallel → ServiceResult[] (ok/error/timeout/skipped); withRetryOnTransient retries once on timeout; analyzeWithClaude returns a non-null string when key set; fysiodk health tab identical after switching.
- **F027.4** — Extract GitHub Actions CI module — _AC:_ fetchWorkflowRuns(token, repo, 1) → WorkflowRun[] (GitHub shape); fetchRunJobs → Job[] with steps; WorkflowRunsCard scaffold uses them + live-polls 5s when hasActiveRuns.
- **F027.5** — Stack A UI scaffold: DeployModal + WorkflowRunsCard — _AC:_ copy-owned React/shadcn in packages/stack-a/deploy/; DeployModal reads SSE from a configurable endpoint, 4-step progress, abort on close, skip-dialog persisted to localStorage; WorkflowRunsCard pages runs + drill-down; full data-testid coverage.
- **F027.6** — Stack B UI scaffold: DeployStatus Preact component — _AC:_ copy-owned Preact in packages/stack-b/deploy/ connects to a Hono SSE route, shows current step + final URL; Preact signals; no React imports; renders in Bun/Vite (Lens capture).

## Acceptance criteria
1. @broberg/deployment-mgmt builds + typechecks clean; headless core imports no framework packages.
2. Each story (F027.1–F027.6) meets its own AC.
3. Piloted in cms and adopted back with no regression (runtime-verified).
4. A second consumer (whop or fysiodk) migrates onto the shared package with identical behaviour.

## Dependencies
- External: node:crypto/fs/child_process (built-in), fetch (native), lucide-react (Stack A UI scaffolds). Related: @broberg/ai (analyzeWithClaude model config).

## Rollout
Strangler: 1) extract fly-live/cloudflare-pages/deploy-event-bus/fly-machines from cms → core, cms adopts back as proving ground; 2) extract probe/escalation from whop, whop adopts back; 3) extract health/multi-service from fysiodk, fysiodk adopts back; 4) extract ci/github-runs from fysiodk; 5) publish; 6) cardmem smoke-fly + buddy dispatch-scheduler + upmetrics probes switch to probe/http; 7) UI scaffolds stay copy-owned (not npm-published). Then GRADUATE the whole epic to its own repo+project.

Graduate-candidate: YES — should get its own repo + cardmem project (recommendation, confirm with Christian).

## Open Questions
- Split flyctl into @broberg/deployment-mgmt/fly-infra so content-sync has zero system-binary deps?
- Multi-machine cms: swap the event bus to Redis, or is single-instance acceptable long-term?
- github-runs token: factory accepting a token, or GITHUB_TOKEN from process.env?
- health/multi-service hardcoded service keys (supabase_db, aws_ses) are fysiodk-specific — generic plugin registry or fixed set + enabledServices subset?
- analyzeWithClaude hardcoded model id — depend on @broberg/ai for model config + caching + retry?

## Effort estimate
**L** — owner session: `cms`. Reuse model: hybrid.

## Risks
flyctl CLI dependency (execFileSync('flyctl')) fails where flyctl isn't on PATH (Docker, CI runners) — extraction must make flyctl optional; content-sync (syncContent/diffManifests) must never require it. CF Pages multipart upload uses Node 20+ FormData+Blob — pin bun >=1.1. deploy-event-bus is single-process — multi-instance Fly silently drops SSE (Redis pub/sub out of v1). analyzeWithClaude hardcodes a model id — replace with @broberg/ai config to avoid silent breakage when retired.