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

// Circuit breaker state: tracks event-loop responsiveness under load.
// If /health endpoint itself takes >500ms (event loop under pressure), increment
// slowResponseCount. When >= 3 consecutive slow responses, report "degraded"
// so cronjobs can back off retries (avoid thundering herd).
const circuitState = {
  slowResponseCount: 0,
  lastResponseTimeMs: 0,
  openedAt: null as number | null,
};

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

  app.get('/health', (c) => {
    const start = Date.now();
    const result = { status: 'ok', service: '@upmetrics/server', ts: start };
    const elapsed = Date.now() - start;
    circuitState.lastResponseTimeMs = elapsed;

    // If /health endpoint took >500ms, event loop is under pressure.
    if (elapsed > 500) {
      circuitState.slowResponseCount++;
      if (circuitState.slowResponseCount === 1) {
        circuitState.openedAt = start;
      }
    } else {
      circuitState.slowResponseCount = 0;
      circuitState.openedAt = null;
    }

    // Circuit OPEN: report degraded so clients (cronjobs) back off.
    if (circuitState.slowResponseCount >= 3) {
      return c.json(
        {
          ...result,
          status: 'degraded',
          reason: 'event_loop_under_pressure',
          circuitState: {
            slowResponseCount: circuitState.slowResponseCount,
            lastResponseTimeMs: circuitState.lastResponseTimeMs,
            openedAt: circuitState.openedAt,
          },
        },
        503,
      );
    }

    return c.json(result);
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
