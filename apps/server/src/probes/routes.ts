// Probe CRUD + cronjobs sync (F004.1). Authed by X-Upmetrics-Key. Creating a
// probe registers a cronjobs trigger job that calls /api/probes/:id/run on
// schedule; deleting removes that job. The actual check logic lives in the run
// endpoint (F004.2) — here it is a guarded stub.
import type { Context, Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { createProbeJob, deleteProbeJob } from './cronjobs';

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

function runUrl(probeId: string, runToken: string): string {
  return `${config.authBaseUrl}/api/probes/${probeId}/run?key=${runToken}`;
}

export function registerProbeRoutes(app: Hono): void {
  // Create
  app.post('/api/probes', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, any>;
    if (!b.name || !b.kind || !b.target || !b.interval_seconds) {
      return c.json({ error: 'missing_fields', need: ['name', 'kind', 'target', 'interval_seconds'] }, 400);
    }
    const db = getDb();
    const id = crypto.randomUUID();
    const runToken = crypto.randomUUID().replace(/-/g, '');
    db.insert(schema.probes)
      .values({
        id,
        projectId: project.id,
        name: b.name,
        kind: b.kind, // http | tcp | keyword | ssl
        target: b.target,
        config: { ...(b.config ?? {}), runToken },
        intervalSeconds: Number(b.interval_seconds),
        status: 'paused',
        consecutiveFailures: 0,
      })
      .run();

    let cronjobsJobId: string | null = null;
    try {
      cronjobsJobId = await createProbeJob(b.name, Number(b.interval_seconds), runUrl(id, runToken));
      db.update(schema.probes).set({ cronjobsJobId }).where(eq(schema.probes.id, id)).run();
    } catch (err) {
      return c.json({ id, cronjobs_synced: false, error: `probe saved but cronjobs sync failed: ${(err as Error).message}` }, 502);
    }
    return c.json({ id, cronjobs_job_id: cronjobsJobId, cronjobs_synced: true });
  });

  // List (project-scoped)
  app.get('/api/probes', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const rows = getDb().select().from(schema.probes).where(eq(schema.probes.projectId, project.id)).all();
    return c.json({ probes: rows });
  });

  // Delete (removes the cronjobs job too)
  app.delete('/api/probes/:id', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const probe = db
      .select()
      .from(schema.probes)
      .where(and(eq(schema.probes.id, c.req.param('id')), eq(schema.probes.projectId, project.id)))
      .get();
    if (!probe) return c.json({ error: 'unknown_probe' }, 404);
    if (probe.cronjobsJobId) await deleteProbeJob(probe.cronjobsJobId).catch(() => {});
    db.delete(schema.probes).where(eq(schema.probes.id, probe.id)).run();
    return c.json({ ok: true });
  });

  // Run trigger — called by cronjobs on schedule. Full check logic is F004.2.
  app.get('/api/probes/:id/run', (c) => {
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'unknown_probe' }, 404);
    const cfg = (probe.config ?? {}) as Record<string, unknown>;
    if (c.req.query('key') !== cfg.runToken) return c.json({ error: 'bad_run_key' }, 401);
    // F004.2 performs the actual HTTP/TCP/keyword/SSL check + records the result.
    return c.json({ ok: true, probe_id: probe.id, note: 'check logic lands in F004.2' });
  });
}
