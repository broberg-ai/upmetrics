// F010.7 — self-service issue resolution. A repo lists + closes its OWN error
// issues headless with its project api_key (X-Upmetrics-Key, the same key as
// cost-ingest / agent / enrollment), so the "fix → resolve → clean board" loop
// needs no dashboard login. Mirrors the cost/enrollment auth pattern; a project
// can only ever see or touch its own issues.
import type { Context, Hono } from 'hono';
import { and, desc, eq, like } from 'drizzle-orm';
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
    const param = c.req.param('id');
    // Exact id first. Fall back to a UNIQUE id-prefix so the short id shown in the
    // dashboard (first 8 chars) resolves without the full UUID — the displayed id
    // should always be actionable. Prefix is hex/dash only (a UUID fragment), so
    // it can't carry a SQL-LIKE wildcard. Ambiguous prefix → 409, never a silent
    // wrong-issue resolve.
    let issue = db
      .select()
      .from(schema.issues)
      .where(and(eq(schema.issues.id, param), eq(schema.issues.projectId, project.id)))
      .get();
    if (!issue && /^[0-9a-f-]{4,}$/i.test(param)) {
      const matches = db
        .select()
        .from(schema.issues)
        .where(and(like(schema.issues.id, `${param}%`), eq(schema.issues.projectId, project.id)))
        .all();
      if (matches.length > 1) return c.json({ error: 'ambiguous_prefix', matches: matches.length }, 409);
      issue = matches[0];
    }
    if (!issue) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = body.status && STATUSES.has(body.status) ? body.status : 'resolved';
    db.update(schema.issues).set({ status }).where(eq(schema.issues.id, issue.id)).run();
    return c.json({ ok: true, id: issue.id, status });
  });

  // Clear slate — resolve (or ignore) ALL of YOUR currently-open issues in one
  // call. For the mass-noise case (e.g. a dev reload-storm that floods the board)
  // where looping per-id is impractical. Body { status?: 'resolved' | 'ignored' },
  // default 'resolved'. Scoped to the caller's project; one bulk UPDATE.
  app.post('/api/issues/resolve-all', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = body.status === 'ignored' ? 'ignored' : 'resolved';
    const where = and(eq(schema.issues.projectId, project.id), eq(schema.issues.status, 'unresolved'));
    const resolved = db.select({ id: schema.issues.id }).from(schema.issues).where(where).all().length;
    db.update(schema.issues).set({ status }).where(where).run();
    return c.json({ ok: true, project: project.id, resolved, status });
  });
}
