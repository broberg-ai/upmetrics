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
import { captureSelf } from './dogfood';

export function createApp() {
  const app = new Hono();

  registerIngestRoutes(app);
  registerAgentRoutes(app);
  registerProbeRoutes(app);
  registerIncidentRoutes(app);
  registerDashboardRoutes(app);

  app.get('/health', (c) =>
    c.json({ status: 'ok', service: '@upmetrics/server', ts: Date.now() }),
  );

  // Better Auth handles all /api/auth/* routes (magic-link, session, callback).
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  // Serve the dashboard SPA (F006). apps/web builds to web-dist, shipped in the
  // image; path is resolved from this file so it's cwd-independent.
  const WEB = join(import.meta.dir, '../web-dist');
  app.get('/assets/*', async (c) => {
    const f = Bun.file(join(WEB, c.req.path));
    return (await f.exists()) ? new Response(f) : c.json({ error: 'not_found' }, 404);
  });

  // Anything else that's a non-API GET → index.html (SPA client-side routing).
  app.notFound(async (c) => {
    if (c.req.method === 'GET' && !c.req.path.startsWith('/api') && c.req.path !== '/health') {
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
