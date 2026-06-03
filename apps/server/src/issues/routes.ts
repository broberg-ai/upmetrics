// F010.7 — self-service issue resolution. A repo lists + closes its OWN error
// issues headless with its project api_key (X-Upmetrics-Key, the same key as
// cost-ingest / agent / enrollment), so the "fix → resolve → clean board" loop
// needs no dashboard login. Mirrors the cost/enrollment auth pattern; a project
// can only ever see or touch its own issues.
import type { Context, Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

const STATUSES = new Set(['resolved', 'ignored', 'unresolved']);

export function registerIssueRoutes(app: Hono): void {
  // List your project's issues (default: open/unresolved). Use the id to resolve.
  app.get('/api/issues', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const statusFilter = c.req.query('status'); // optional exact filter; default = unresolved only
    const rows = db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.projectId, project.id))
      .orderBy(desc(schema.issues.lastSeen))
      .all()
      .filter((r) => (statusFilter ? r.status === statusFilter : r.status === 'unresolved'))
      .map((r) => ({
        id: r.id,
        title: r.title,
        culprit: r.culprit,
        level: r.level,
        status: r.status,
        event_count: r.eventCount,
        first_seen: r.firstSeen,
        last_seen: r.lastSeen,
      }));
    return c.json({ project: project.id, issues: rows });
  });

  // Resolve (or ignore / reopen) one of YOUR issues. Body: { status?: 'resolved'
  // | 'ignored' | 'unresolved' }, default 'resolved'. 404 if the issue isn't
  // yours — a project can never touch another project's issues.
  app.post('/api/issues/:id/resolve', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const id = c.req.param('id');
    const issue = db
      .select()
      .from(schema.issues)
      .where(and(eq(schema.issues.id, id), eq(schema.issues.projectId, project.id)))
      .get();
    if (!issue) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = body.status && STATUSES.has(body.status) ? body.status : 'resolved';
    db.update(schema.issues).set({ status }).where(eq(schema.issues.id, id)).run();
    return c.json({ ok: true, id, status });
  });
}
