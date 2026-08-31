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
const INCIDENT_STATUSES = new Set(['resolved', 'acknowledged', 'open']);

// One shape for an event, used by both read routes. The stack is handed over as
// the SDK sent it — an empty `frames` array is a real answer (the event arrived
// without an origin) and must stay visible rather than be smoothed into null.
function shapeEvent(e: { id: string; receivedAt: Date; occurredAt: Date; release: string | null; environment: string | null; tags: unknown; payload: unknown }) {
  const p = (e.payload ?? {}) as Record<string, any>;
  const exc = p.exception?.values?.[0];
  return {
    id: e.id,
    received_at: e.receivedAt,
    occurred_at: e.occurredAt,
    release: e.release,
    environment: e.environment,
    tags: e.tags ?? p.tags ?? null,
    type: exc?.type ?? null,
    value: exc?.value ?? p.message ?? null,
    frames: exc?.stacktrace?.frames ?? [],
  };
}

// Exact id first, then a UNIQUE id-prefix so the short id shown in the dashboard
// (first 8 chars) is actionable without the full UUID. The prefix is hex/dash
// only, so it cannot carry a SQL-LIKE wildcard. An ambiguous prefix is an error,
// never a silent hit on the wrong record.
function findByIdOrPrefix<T extends { id: string }>(rows: T[], param: string): T | 'ambiguous' | null {
  const exact = rows.find((r) => r.id === param);
  if (exact) return exact;
  if (!/^[0-9a-f-]{4,}$/i.test(param)) return null;
  const matches = rows.filter((r) => r.id.startsWith(param));
  if (matches.length > 1) return 'ambiguous';
  return matches[0] ?? null;
}

export function registerIssueRoutes(app: Hono): void {
  // List your project's issues (default: open/unresolved). Use the id to resolve.
  app.get('/api/issues', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    // `status=all` used to return [] — the filter compared the literal "all"
    // against each row's status, so it matched nothing while `resolved` and
    // `ignored` both had rows. A caller asking for everything got the calmest
    // possible answer: an empty list that reads as "no errors". Reported by cms
    // 2026-08-31, who noticed only because the other two filters disagreed with it.
    const statusFilter = c.req.query('status'); // exact status, 'all', or absent = unresolved only
    // An UNKNOWN status is an error, not an empty result. Fixing 'all' alone
    // would have moved the same trap one step sideways: ?status=vrøvl would
    // still answer [], and in an error-tracking API an empty array reads as
    // "nothing is wrong". Named by super 2026-08-31, who asked what the fix did
    // with a value it did not know rather than taking the fix on trust.
    // Three states, not two: known filter · unknown filter · no filter.
    if (statusFilter && statusFilter !== 'all' && !STATUSES.has(statusFilter)) {
      return c.json({ error: 'unknown_status', got: statusFilter, valid: [...STATUSES, 'all'] }, 400);
    }
    const rows = db
      .select()
      .from(schema.issues)
      .where(eq(schema.issues.projectId, project.id))
      .orderBy(desc(schema.issues.lastSeen))
      .all()
      .filter((r) => (!statusFilter ? r.status === 'unresolved' : statusFilter === 'all' ? true : r.status === statusFilter))
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

  // ── F026.3 — see WHAT the error is, not just that it exists ────────────────
  //
  // Without these, a repo could list an issue and close it, but never read the
  // stack, release or tags behind it. cms put it plainly on 2026-08-25: "Jeg
  // lukker den ikke i blinde" — the right instinct, which the tooling made
  // impossible to keep. Answering them required a hand-run query against the
  // prod database over fly ssh, which does not scale and turns the
  // close-your-own-errors rule into a courtesy phrase.
  app.get('/api/issues/:id', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const all = db.select().from(schema.issues).where(eq(schema.issues.projectId, project.id)).all();
    const hit = findByIdOrPrefix(all, c.req.param('id'));
    if (hit === 'ambiguous') return c.json({ error: 'ambiguous_prefix' }, 409);
    if (!hit) return c.json({ error: 'not_found' }, 404);
    const latest = db
      .select()
      .from(schema.events)
      .where(eq(schema.events.issueId, hit.id))
      .orderBy(desc(schema.events.receivedAt))
      .limit(1)
      .get();
    return c.json({
      id: hit.id,
      project: project.id,
      title: hit.title,
      culprit: hit.culprit,
      level: hit.level,
      status: hit.status,
      fingerprint: hit.fingerprint,
      event_count: hit.eventCount,
      first_seen: hit.firstSeen,
      last_seen: hit.lastSeen,
      latest_event: latest ? shapeEvent(latest) : null,
    });
  });

  // The events behind one issue, newest first. `?limit=` caps the page (default
  // 10, max 50) — a busy issue has thousands and nobody reads them all.
  app.get('/api/issues/:id/events', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const all = db.select().from(schema.issues).where(eq(schema.issues.projectId, project.id)).all();
    const hit = findByIdOrPrefix(all, c.req.param('id'));
    if (hit === 'ambiguous') return c.json({ error: 'ambiguous_prefix' }, 409);
    if (!hit) return c.json({ error: 'not_found' }, 404);
    const raw = Number(c.req.query('limit'));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 50) : 10;
    const rows = db
      .select()
      .from(schema.events)
      .where(eq(schema.events.issueId, hit.id))
      .orderBy(desc(schema.events.receivedAt))
      .limit(limit)
      .all();
    return c.json({ issue: hit.id, project: project.id, count: rows.length, events: rows.map(shapeEvent) });
  });

  // ── F026.2 — a repo can see and close its own INCIDENTS ────────────────────
  //
  // Responsibility without access becomes noise at the owner. CLAUDE.md makes
  // closing your own errors an inviolable rule, and until now we only exposed
  // half the signal: issues had a self-service route, incidents had none. So a
  // deploy_regression that had long since been superseded kept alerting, and the
  // only repo that could judge it had no way to close it. Measured: one such
  // incident fired 124 times over five days about a release replaced within the
  // hour, and 23 of the 24 alerts in the last day came from it alone.
  //
  // F026.1 now retires that specific kind automatically. This route is for the
  // rest — and for the case where a human knows something the correlator cannot.
  app.get('/api/incidents', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const statusFilter = c.req.query('status'); // exact status, 'all', or absent = open only
    // Same three states as /api/issues — an unknown status must not answer [].
    if (statusFilter && statusFilter !== 'all' && !INCIDENT_STATUSES.has(statusFilter)) {
      return c.json({ error: 'unknown_status', got: statusFilter, valid: [...INCIDENT_STATUSES, 'all'] }, 400);
    }
    const rows = getDb()
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.projectId, project.id))
      .orderBy(desc(schema.incidents.openedAt))
      .all()
      .filter((r) => (!statusFilter ? r.status === 'open' : statusFilter === 'all' ? true : r.status === statusFilter))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        severity: r.severity,
        title: r.title,
        opened_at: r.openedAt,
        resolved_at: r.resolvedAt,
        trigger_ref: r.triggerRef,
      }));
    return c.json({ project: project.id, incidents: rows });
  });

  // Close one of YOUR incidents. Body { status?: 'resolved' | 'acknowledged' |
  // 'open' }, default 'resolved'. 404 if it is not yours.
  app.post('/api/incidents/:id/resolve', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const db = getDb();
    const all = db.select().from(schema.incidents).where(eq(schema.incidents.projectId, project.id)).all();
    const hit = findByIdOrPrefix(all, c.req.param('id'));
    if (hit === 'ambiguous') return c.json({ error: 'ambiguous_prefix' }, 409);
    if (!hit) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = body.status && INCIDENT_STATUSES.has(body.status) ? body.status : 'resolved';
    db.update(schema.incidents)
      .set({ status, resolvedAt: status === 'resolved' ? new Date() : null })
      .where(eq(schema.incidents.id, hit.id))
      .run();
    return c.json({ ok: true, id: hit.id, status });
  });
}
