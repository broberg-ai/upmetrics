// Hono application factory. Routes for ingest/probes/incidents/auth are mounted
// in later stories (F002+); this is the skeleton with /health + error handling.
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({ status: 'ok', service: '@upmetrics/server', ts: Date.now() }),
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  app.onError((err, c) => {
    console.error('[server] unhandled error:', err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
