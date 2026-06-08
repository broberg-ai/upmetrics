// F019 — deploy-event observe surface. The execution side (cms/whop/fysiodk)
// POSTs deploy status here with its project key (X-Upmetrics-Key, same key as
// cost/ingest); upmetrics OBSERVES — it never triggers a deploy. One row per
// deploy, upserted on (project_id, deploy_id) as status transitions; the relay
// (F019.7) reads terminal rows, the registry (F019.8) reads latest success.
import type { Context, Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';

const STATUSES = new Set(['pending', 'running', 'success', 'failure']);
const isTerminal = (s: string) => s === 'success' || s === 'failure';

function projectFromKey(c: Context) {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
}

export function registerDeployRoutes(app: Hono): void {
  // Ingest — execution side reports a deploy's status. Authed by project key.
  // Idempotent on deploy_id: re-POSTing the same deploy_id updates the one row in
  // place (status transitions), so the relay/registry stay clean. No deploy_id →
  // a fresh row each time (an anonymous deploy can't be deduped).
  app.post('/api/deploys', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!b.site || !b.status) return c.json({ error: 'missing_fields', need: ['site', 'status'] }, 400);
    if (typeof b.status !== 'string' || !STATUSES.has(b.status)) {
      return c.json({ error: 'invalid_status', allowed: [...STATUSES] }, 400);
    }

    const db = getDb();
    const now = new Date();
    const deployId = b.deploy_id != null && b.deploy_id !== '' ? String(b.deploy_id) : null;

    const existing = deployId
      ? db
          .select()
          .from(schema.deployEvents)
          .where(and(eq(schema.deployEvents.projectId, project.id), eq(schema.deployEvents.deployId, deployId)))
          .get()
      : undefined;

    if (existing) {
      // Merge, don't replace: a status-only update must NOT wipe sha/version/
      // originator set on an earlier transition (the relay routes on originator).
      const patch: Partial<typeof schema.deployEvents.$inferInsert> = { status: b.status, updatedAt: now };
      if (b.site != null) patch.site = String(b.site);
      if (b.provider != null) patch.provider = String(b.provider);
      if (b.sha != null) patch.sha = String(b.sha);
      if (b.version != null) patch.version = String(b.version);
      if (b.originator != null) patch.originator = String(b.originator);
      db.update(schema.deployEvents).set(patch).where(eq(schema.deployEvents.id, existing.id)).run();
      // F019.7 — a terminal deploy with no originator can't be relayed (no
      // cc-session to ping); it's excluded from the relay feed. Log for visibility.
      if (isTerminal(b.status) && b.originator == null && existing.originator == null) {
        console.warn(`[deploys] terminal deploy ${existing.id} (${existing.site}) has no originator — relay skipped`);
      }
      return c.json({ id: existing.id, deduped: true, status: b.status });
    }

    const id = crypto.randomUUID();
    db.insert(schema.deployEvents)
      .values({
        id,
        projectId: project.id,
        deployId,
        site: String(b.site),
        provider: b.provider != null ? String(b.provider) : null,
        status: b.status,
        sha: b.sha != null ? String(b.sha) : null,
        version: b.version != null ? String(b.version) : null,
        originator: b.originator != null ? String(b.originator) : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (isTerminal(b.status) && b.originator == null) {
      console.warn(`[deploys] terminal deploy ${id} (${String(b.site)}) has no originator — relay skipped`);
    }
    return c.json({ id, deduped: false, status: b.status });
  });

  // F019.8 — release registry. Public read (the PWA shell polls this client-side
  // to detect a new version): latest SUCCESS for a site. No PII, no project
  // internals — just version/sha/deployedAt. 404 when the site has no success yet.
  app.get('/release/:site', (c) => {
    const site = c.req.param('site');
    const row = getDb()
      .select()
      .from(schema.deployEvents)
      .where(and(eq(schema.deployEvents.site, site), eq(schema.deployEvents.status, 'success')))
      .orderBy(desc(schema.deployEvents.updatedAt))
      .limit(1)
      .get();
    if (!row) return c.json({ error: 'no_release', site }, 404);
    return c.json({ site, version: row.version, sha: row.sha, deployedAt: row.updatedAt.toISOString() });
  });
}
