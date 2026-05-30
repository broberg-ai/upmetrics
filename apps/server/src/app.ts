// Hono application factory. Routes for ingest/probes/incidents/auth are mounted
// in later stories (F002+); this is the skeleton with /health + error handling.
import { Hono } from 'hono';
import { auth } from './auth';
import { registerIngestRoutes } from './ingest/routes';
import { registerAgentRoutes } from './ingest/agent';
import { registerProbeRoutes } from './probes/routes';
import { registerIncidentRoutes } from './incidents/routes';
import { registerDashboardRoutes } from './dashboard/routes';

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

  // Minimal landing — magic-link verify redirects here until the F006 dashboard
  // exists. Reads ?error= so an expired/invalid link isn't reported as success.
  app.get('/', (c) => {
    const error = c.req.query('error');
    const body = error
      ? `<h1>Upmetrics</h1><p style="color:#b00">⚠ Sign-in link ${error === 'EXPIRED_TOKEN' ? 'expired' : 'failed'} (${error}).</p><p>Request a new magic link and click it within 15 minutes.</p>`
      : `<h1>Upmetrics</h1><p>✓ Server is running. If you arrived from a sign-in link, you're authenticated — your session cookie is set.</p>`;
    return c.html(
      `<!doctype html><meta charset="utf-8"><title>Upmetrics</title>` +
        `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
        body +
        `<p style="color:#666">Dashboard UI lands in F006.</p></body>`,
    );
  });

  // Better Auth handles all /api/auth/* routes (magic-link, session, callback).
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    console.error('[server] unhandled error:', err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
