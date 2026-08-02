// Hono application factory. Routes for ingest/probes/incidents/auth are mounted
// in later stories (F002+); this is the skeleton with /health + error handling.
import { Hono } from 'hono';
import { join } from 'node:path';
import { auth } from './auth';
import { registerIngestRoutes } from './ingest/routes';
import { registerAgentRoutes } from './ingest/agent';
import { registerProbeRoutes } from './probes/routes';
import { registerIncidentRoutes } from './incidents/routes';
import { registerDashboardRoutes } from './dashboard/routes';
import { registerCostRoutes } from './cost/routes';
import { registerRemediationRoutes } from './incidents/relay';
import { registerIssueRoutes } from './issues/routes';
import { registerDeployRoutes } from './deploys/routes';
import { registerDeployRelayRoutes } from './deploys/relay';
import { registerLensRoutes } from './auth/lens';
import { registerCreditRoutes } from './credits/routes';
import { registerFxRoutes } from './fx/routes';
import { captureSelf } from './dogfood';
import { eventLoopLagMs } from './ops/lag-gauge';
import { lastDiskUsage, bandFor } from './ops/diskguard';

// F008 circuit breaker. When the event loop lags past this, /ready reports
// degraded (503 + Retry-After) so a poller BACKS OFF instead of alarming.
const READY_LAG_DEGRADED_MS = 2000; // >2s of event-loop lag = degraded
const READY_RETRY_AFTER_S = 15; // "try again in 15s" — long enough to self-recover

export function createApp() {
  const app = new Hono();

  registerIngestRoutes(app);
  registerAgentRoutes(app);
  registerProbeRoutes(app);
  registerIncidentRoutes(app);
  registerDashboardRoutes(app);
  registerCostRoutes(app); // F014 — per-project cost read-API
  registerRemediationRoutes(app); // F010 — auto-remediation pull-feed
  registerIssueRoutes(app); // F010.7 — self-service issue list + resolve (project key)
  registerDeployRoutes(app); // F019 — deploy-event ingest + release registry (observe-only)
  registerDeployRelayRoutes(app); // F019.7 — deploy-complete relay pull-feed (buddy polls, then stamps)
  registerLensRoutes(app); // F016 — Lens mint-endpoint (read-only visual-verification session)
  registerCreditRoutes(app); // F022 — provider credit-snapshot ingest + export-API
  registerFxRoutes(app); // F023 — public live USD→DKK rate

  // Liveness (Fly health check). Pure: 200 whenever the process can answer at
  // all. It must NEVER 503 for mere pressure — a 503 here makes Fly pull our
  // ONLY instance from the proxy → a self-inflicted user-facing outage. Degraded
  // state belongs on /ready (below), not here. lag_ms is exposed for observability.
  // disk: last diskguard measurement (F025.1). Cached, so this stays a pure
  // in-memory read — and it is visible even when the DB is unwritable, which is
  // exactly when someone is looking.
  app.get('/health', (c) => {
    const d = lastDiskUsage();
    return c.json({
      status: 'ok',
      service: '@upmetrics/server',
      ts: Date.now(),
      lag_ms: Math.round(eventLoopLagMs()),
      ...(d
        ? {
            disk: {
              used_pct: Number(d.usedPct.toFixed(1)),
              avail_bytes: d.availBytes,
              wal_bytes: d.walBytes,
              band: bandFor(d.usedPct),
              measured_at: d.at,
            },
          }
        : {}),
    });
  });

  // Readiness (F008 circuit breaker). For a poller (the cronjobs deadman) that
  // should DEFER, not alarm, while we're briefly degraded. When the event loop
  // recently stalled (a heavy sync query on a cold cache), report 503 + Retry-After
  // → the deadman treats it as "try again soon" (its F007 defer-on-Retry-After
  // path) instead of paging. A true hang makes THIS time out too → then it pages,
  // which is correct. Separate from /health so Fly's liveness is never affected.
  app.get('/ready', (c) => {
    const lag = Math.round(eventLoopLagMs());
    if (lag > READY_LAG_DEGRADED_MS) {
      c.header('Retry-After', String(READY_RETRY_AFTER_S));
      return c.json({ status: 'degraded', reason: 'event_loop_lag', lag_ms: lag, retry_after: READY_RETRY_AFTER_S }, 503);
    }
    return c.json({ status: 'ready', lag_ms: lag });
  });

  // Fleet test fixture (cronjobs F007): a DETERMINISTIC 503 + Retry-After so a
  // consumer can prove its "defer on Retry-After, don't alarm" path against a
  // real upstream — no public endpoint reliably sets this header, this one
  // always does. Harmless (returns no data), never wired to an uptime probe so
  // it can't self-alarm, and deliberately NOT under /health so it can never
  // interfere with Fly's health check.
  app.get('/api/test/retry-after-503', (c) => {
    c.header('Retry-After', '30');
    return c.json({ test: 'retry-after-503', retry_after: 30 }, 503);
  });

  // Better Auth handles all /api/auth/* routes (magic-link, session, callback).
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Serve the dashboard SPA (F006). apps/web builds to web-dist, shipped in the
  // image; path is resolved from this file so it's cwd-independent.
  const WEB = join(import.meta.dir, '../web-dist');
  app.get('/assets/*', async (c) => {
    const f = Bun.file(join(WEB, c.req.path));
    return (await f.exists()) ? new Response(f) : c.json({ error: 'not_found' }, 404);
  });

  // Anything else that's a non-API GET → serve a real web-dist file if one
  // exists (favicon.svg, etc.), else index.html (SPA client-side routing).
  app.notFound(async (c) => {
    if (c.req.method === 'GET' && !c.req.path.startsWith('/api') && c.req.path !== '/health') {
      const rel = c.req.path.replace(/^\/+/, '');
      if (rel && !rel.includes('..')) {
        const f = Bun.file(join(WEB, rel));
        if (await f.exists()) return new Response(f);
      }
      const index = Bun.file(join(WEB, 'index.html'));
      if (await index.exists()) return new Response(index);
    }
    return c.json({ error: 'not_found' }, 404);
  });

  app.onError((err, c) => {
    console.error('[server] unhandled error:', err);
    // F009.1 dogfood: ship our own 500s to the upmetrics self-project.
    captureSelf(err, { request: { url: c.req.url, method: c.req.method } });
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
