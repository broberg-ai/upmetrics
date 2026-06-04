// Dashboard read API (F006). Thin, auth-gated read endpoints the SPA consumes.
// Business logic stays server-side; the SPA only renders. All routes require a
// valid Better Auth session (the dashboard cookie).
import type { Context, Hono } from 'hono';
import { and, desc, eq, gte, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { auth } from '../auth';
import { validLensSession } from '../auth/lens';
import { deleteProbeJob, setProbeJobEnabled, updateProbeJob } from '../probes/cronjobs';
import { dispatchRemediation } from '../incidents/remediation';
import { pendingRemediations, enrollmentView, buildEnrollmentPatch, applyEnrollment } from '../incidents/relay';
import { config } from '../config';
import { randomBytes } from 'node:crypto';

// F015 — credential generators. DSN host derives from authBaseUrl (single source,
// never hardcoded). DSN public key = 16-byte hex (matches the ingest contract:
// envelope checks extractPublicKey(dsn) === incoming key). api_key = uk_<24B hex>.
export const genApiKey = () => `uk_${randomBytes(24).toString('hex')}`;
export const buildDsn = (id: string) => `https://${randomBytes(16).toString('hex')}@${new URL(config.authBaseUrl).host}/${id}`;
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

async function requireUser(c: Context): Promise<boolean> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) return true;
  // F016 — Lens read-only principal: a valid mint cookie authorizes GET (render)
  // only. It can never pass a mutating method, so the lens session is
  // structurally read-only (POST/PATCH/DELETE → 401). Never cb@/admin.
  if (c.req.method === 'GET' && validLensSession(c)) return true;
  return false;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function countWhere(table: any, where: any): number {
  return getDb().select({ n: sql<number>`count(*)` }).from(table).where(where).get()?.n ?? 0;
}

export function registerDashboardRoutes(app: Hono): void {
  // Per-project health + global matrix (F006.2).
  app.get('/api/dashboard/overview', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const today = startOfToday();

    const projects = db.select().from(schema.projects).all();
    const rows = projects.map((p) => {
      const probes = db.select({ status: schema.probes.status }).from(schema.probes).where(eq(schema.probes.projectId, p.id)).all();
      const total = probes.length;
      const up = probes.filter((x) => x.status === 'up').length;
      const down = probes.filter((x) => x.status === 'down').length;
      const probeUpPct = total === 0 ? null : Math.round((up / total) * 100);

      const openIssues = countWhere(schema.issues, and(eq(schema.issues.projectId, p.id), eq(schema.issues.status, 'unresolved')));
      const openIncidents = countWhere(schema.incidents, and(eq(schema.incidents.projectId, p.id), eq(schema.incidents.status, 'open')));
      const agentCostToday =
        db
          .select({ s: sql<number>`coalesce(sum(cost_usd),0)` })
          .from(schema.agentRuns)
          .where(and(eq(schema.agentRuns.projectId, p.id), gte(schema.agentRuns.startedAt, today)))
          .get()?.s ?? 0;
      // All-time cumulative agent cost — the meaningful per-project + fleet "total"
      // (today resets at midnight). Cheap SUM over the indexed project_id.
      const agentCostTotal =
        db
          .select({ s: sql<number>`coalesce(sum(cost_usd),0)` })
          .from(schema.agentRuns)
          .where(eq(schema.agentRuns.projectId, p.id))
          .get()?.s ?? 0;

      const status = down > 0 || openIncidents > 0 ? 'down' : openIssues > 0 ? 'degraded' : 'ok';
      return {
        id: p.id,
        name: p.name,
        platform: p.platform,
        probe_up_pct: probeUpPct,
        probe_total: total,
        open_issues: openIssues,
        open_incidents: openIncidents,
        agent_cost_today: Number(agentCostToday),
        agent_cost_total: Number(agentCostTotal),
        status,
      };
    });

    return c.json({
      projects: rows,
      totals: {
        projects: rows.length,
        open_issues: rows.reduce((a, r) => a + r.open_issues, 0),
        open_incidents: rows.reduce((a, r) => a + r.open_incidents, 0),
        agent_cost_today: rows.reduce((a, r) => a + r.agent_cost_today, 0),
        agent_cost_total: rows.reduce((a, r) => a + r.agent_cost_total, 0),
      },
    });
  });

  // Project detail page (standalone per-repo view). Summary + the distinct
  // surfaces (release tags) that have reported, e.g. Trail → trail-admin /
  // trail-engine / trail-admin-server. One repo is one project; each component
  // identifies itself via the SDK `release` it sets at init().
  app.get('/api/dashboard/projects/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const pid = c.req.param('id');
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, pid)).get();
    if (!project) return c.json({ error: 'not_found' }, 404);
    const today = startOfToday();

    const rows = db
      .select({
        release: schema.events.release,
        environment: schema.events.environment,
        total: sql<number>`count(*)`,
        errors: sql<number>`sum(case when ${schema.events.kind} = 'error' then 1 else 0 end)`,
        last_seen: sql<number>`max(${schema.events.receivedAt})`,
        // F012 — SDK version of the LATEST event per release. SQLite returns a
        // bare column from the same row as max() in the SELECT, so this is the
        // newest event's stamped version (null for pre-F012 events).
        sdk_version: sql<string | null>`json_extract(${schema.events.payload}, '$.sdk.version')`,
      })
      .from(schema.events)
      .where(eq(schema.events.projectId, pid))
      .groupBy(schema.events.release, schema.events.environment)
      .all();

    const components = rows
      .map((r) => ({
        release: r.release ?? '(untagged)',
        environment: r.environment ?? null,
        total: Number(r.total),
        errors: Number(r.errors),
        last_seen: r.last_seen ? Number(r.last_seen) : null,
        sdk_version: r.sdk_version ?? null,
      }))
      .sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0));

    // Newest SDK version seen across this project's surfaces → the dashboard
    // marks anything behind it as drifted (F012).
    const cmpVer = (a: string, b: string) =>
      a.split('.').map(Number).reduce((acc, n, i) => acc || (n - (Number(b.split('.')[i]) || 0)), 0);
    const latestSdkVersion = components.map((x) => x.sdk_version).filter((v): v is string => !!v).sort(cmpVer).at(-1) ?? null;

    const costAgg = (where: any) =>
      Number(db.select({ s: sql<number>`coalesce(sum(cost_usd),0)` }).from(schema.agentRuns).where(where).get()?.s ?? 0);

    return c.json({
      project: { id: project.id, name: project.name, platform: project.platform },
      open_issues: countWhere(schema.issues, and(eq(schema.issues.projectId, pid), eq(schema.issues.status, 'unresolved'))),
      open_incidents: countWhere(schema.incidents, and(eq(schema.incidents.projectId, pid), eq(schema.incidents.status, 'open'))),
      total_events: components.reduce((a, x) => a + x.total, 0),
      cost_today: costAgg(and(eq(schema.agentRuns.projectId, pid), gte(schema.agentRuns.startedAt, today))),
      cost_total: costAgg(eq(schema.agentRuns.projectId, pid)),
      latest_sdk_version: latestSdkVersion,
      components,
      remediation: enrollmentView(project), // F010.5 — current enrollment for the settings card
      credentials: { dsn: project.dsn, api_key: project.apiKey }, // F015 — session-authed reveal
    });
  });

  // F015 — create a new project ("customer"): generates DSN + api_key. Session auth.
  app.post('/api/dashboard/projects', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const body = (await c.req.json().catch(() => ({}))) as { id?: string; name?: string; platform?: string };
    const id = String(body.id ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(id)) return c.json({ error: 'invalid_slug', message: 'id must be [a-z0-9-], 2–39 chars' }, 400);
    if (db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()) return c.json({ error: 'slug_taken' }, 409);
    const name = String(body.name ?? '').trim() || id;
    const platform = ['web', 'node', 'capacitor', 'native'].includes(String(body.platform)) ? String(body.platform) : 'web';
    const dsn = buildDsn(id);
    const apiKey = genApiKey();
    const now = new Date();
    db.insert(schema.projects).values({ id, name, dsn, apiKey, platform, createdAt: now, updatedAt: now }).run();
    return c.json({ project: { id, name, platform }, dsn, api_key: apiKey }, 201);
  });

  // F015 — rotate a project's api_key (old key stops authenticating). Session auth.
  app.post('/api/dashboard/projects/:id/rotate-key', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const id = c.req.param('id');
    if (!db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()) return c.json({ error: 'not_found' }, 404);
    const apiKey = genApiKey();
    db.update(schema.projects).set({ apiKey, updatedAt: new Date() }).where(eq(schema.projects.id, id)).run();
    return c.json({ ok: true, api_key: apiKey });
  });

  // F010.5 — update a project's remediation enrollment from the dashboard
  // (session auth). Same validation/write path as the self-service key route.
  app.patch('/api/dashboard/projects/:id/remediation', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, c.req.param('id'))).get();
    if (!project) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch = buildEnrollmentPatch(body);
    if ('error' in patch) return c.json(patch, 400);
    return c.json(applyEnrollment(db, project.id, patch));
  });

  // The actual errors behind a component's count — so "22 err" is drillable.
  // Joins events (for that release) to their issue for a human title. Untagged
  // components pass release=__none__.
  app.get('/api/dashboard/projects/:id/component-errors', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const pid = c.req.param('id');
    const release = c.req.query('release');
    const relCond = release && release !== '__none__' ? eq(schema.events.release, release) : sql`${schema.events.release} is null`;
    const rows = db
      .select({
        event_id: schema.events.id,
        issue_id: schema.events.issueId,
        occurred_at: schema.events.occurredAt,
        payload: schema.events.payload,
        issue_title: schema.issues.title,
        issue_status: schema.issues.status,
      })
      .from(schema.events)
      .leftJoin(schema.issues, eq(schema.events.issueId, schema.issues.id))
      .where(and(eq(schema.events.projectId, pid), eq(schema.events.kind, 'error'), relCond))
      .orderBy(desc(schema.events.receivedAt))
      .limit(50)
      .all();

    const errors = rows.map((r) => {
      const ex = (r.payload as any)?.exception?.values?.[0] ?? {};
      return {
        event_id: r.event_id,
        issue_id: r.issue_id,
        title: r.issue_title ?? ex.type ?? 'Error',
        type: ex.type ?? null,
        value: ex.value ?? null,
        status: r.issue_status ?? null,
        occurred_at: r.occurred_at,
      };
    });
    return c.json({ errors });
  });

  // Open incidents for the global bar (F006.5 consumes; cheap + handy now).
  app.get('/api/dashboard/incidents/open', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const rows = getDb()
      .select()
      .from(schema.incidents)
      .where(eq(schema.incidents.status, 'open'))
      .orderBy(desc(schema.incidents.openedAt))
      .all();
    return c.json({ incidents: rows });
  });

  // Project list (id + name) for dashboard filters.
  app.get('/api/dashboard/projects', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const rows = getDb().select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).all();
    return c.json({ projects: rows });
  });

  // Issues list (F006.3) — filter by project/status + title search.
  app.get('/api/dashboard/issues', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const project = c.req.query('project');
    const status = c.req.query('status');
    const q = c.req.query('q');
    const conds = [];
    if (project) conds.push(eq(schema.issues.projectId, project));
    if (status) conds.push(eq(schema.issues.status, status));
    if (q) conds.push(sql`lower(${schema.issues.title}) like ${'%' + q.toLowerCase() + '%'}`);
    const base = db.select().from(schema.issues);
    const rows = (conds.length ? base.where(and(...conds)) : base).orderBy(desc(schema.issues.lastSeen)).limit(200).all();
    return c.json({ issues: rows });
  });

  // Issue detail — issue + recent events (stack/breadcrumbs/tags) + related agent runs.
  app.get('/api/dashboard/issues/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const issue = db.select().from(schema.issues).where(eq(schema.issues.id, c.req.param('id'))).get();
    if (!issue) return c.json({ error: 'not_found' }, 404);
    const events = db.select().from(schema.events).where(eq(schema.events.issueId, issue.id)).orderBy(desc(schema.events.receivedAt)).limit(20).all();
    const relatedRuns = db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.errorIssueId, issue.id))
      .orderBy(desc(schema.agentRuns.startedAt))
      .limit(20)
      .all();
    // F006.3 — the project's "owner/repo" for the Create-GitHub-issue deep-link.
    const project = db.select({ githubRepo: schema.projects.githubRepo }).from(schema.projects).where(eq(schema.projects.id, issue.projectId)).get();
    return c.json({ issue, events, related_agent_runs: relatedRuns, github_repo: project?.githubRepo ?? null });
  });

  // Issue actions — resolve / ignore / reopen.
  app.post('/api/dashboard/issues/:id/status', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const b = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = String(b.status ?? '');
    if (!['unresolved', 'resolved', 'ignored'].includes(status)) return c.json({ error: 'bad_status' }, 400);
    getDb().update(schema.issues).set({ status }).where(eq(schema.issues.id, c.req.param('id'))).run();
    return c.json({ ok: true });
  });

  app.post('/api/dashboard/issues/:id/assign', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const b = (await c.req.json().catch(() => ({}))) as { assignee?: string | null };
    getDb().update(schema.issues).set({ assignee: b.assignee ?? null }).where(eq(schema.issues.id, c.req.param('id'))).run();
    return c.json({ ok: true });
  });

  // F010.4 — manually push an issue to the remediation feed (→ Buddy → cc
  // session). For issues that never hit the auto error-spike threshold but a
  // human wants fixed now. Creates (or re-arms) an open manual_remediation
  // incident keyed to the issue; it enters /api/remediation/pending bypassing
  // the severity + opt-in gates. Idempotent per open issue.
  app.post('/api/dashboard/issues/:id/push-remediation', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const issue = db.select().from(schema.issues).where(eq(schema.issues.id, c.req.param('id'))).get();
    if (!issue) return c.json({ error: 'not_found' }, 404);
    const now = new Date();
    const existing = db
      .select()
      .from(schema.incidents)
      .where(and(eq(schema.incidents.triggerRef, issue.id), eq(schema.incidents.kind, 'manual_remediation'), eq(schema.incidents.status, 'open')))
      .get();
    if (existing) {
      if (existing.relayClaimedAt) return c.json({ ok: true, already_claimed: true, incident_id: existing.id });
      db.update(schema.incidents).set({ relayRequestedAt: now }).where(eq(schema.incidents.id, existing.id)).run();
      return c.json({ ok: true, incident_id: existing.id });
    }
    const id = crypto.randomUUID();
    db.insert(schema.incidents)
      .values({
        id,
        projectId: issue.projectId,
        kind: 'manual_remediation',
        status: 'open',
        severity: issue.level === 'fatal' ? 'critical' : 'high',
        title: `Manual remediation: ${issue.title}`,
        openedAt: now,
        triggerRef: issue.id,
        relayRequestedAt: now,
      })
      .run();
    return c.json({ ok: true, incident_id: id });
  });

  // F010.4 — remediation view: what's awaiting a cc session (pending) and what
  // has been pushed/claimed (history), so the loop is visible, not just auto.
  app.get('/api/dashboard/remediation', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const names = new Map(db.select({ id: schema.projects.id, name: schema.projects.name }).from(schema.projects).all().map((p) => [p.id, p.name]));
    const rows = db
      .select()
      .from(schema.incidents)
      .where(or(isNotNull(schema.incidents.relayClaimedAt), isNotNull(schema.incidents.relayRequestedAt)))
      .orderBy(desc(schema.incidents.openedAt))
      .limit(100)
      .all();
    const history = rows.map((i) => ({
      incident_id: i.id,
      project: i.projectId,
      project_name: names.get(i.projectId) ?? i.projectId,
      title: i.title,
      kind: i.kind,
      severity: i.severity,
      status: i.status,
      manual: Boolean(i.relayRequestedAt),
      relay_session: i.relaySession,
      requested_at: i.relayRequestedAt,
      claimed_at: i.relayClaimedAt,
      opened_at: i.openedAt,
    }));
    return c.json({ pending: pendingRemediations(db), history });
  });

  // ── Agents (F006.4) — the §8 differentiator ──────────────────────────────
  // Runs list with filters.
  app.get('/api/dashboard/agents', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const conds = [];
    const project = c.req.query('project');
    const agent = c.req.query('agent');
    const status = c.req.query('status');
    const kind = c.req.query('kind');
    const since = c.req.query('since');
    const until = c.req.query('until');
    if (project) conds.push(eq(schema.agentRuns.projectId, project));
    if (agent) conds.push(eq(schema.agentRuns.agentName, agent));
    if (status) conds.push(eq(schema.agentRuns.status, status));
    if (kind) conds.push(eq(schema.agentRuns.agentKind, kind));
    if (since) conds.push(gte(schema.agentRuns.startedAt, new Date(since)));
    if (until) conds.push(lte(schema.agentRuns.startedAt, new Date(until + 'T23:59:59.999Z')));
    const base = db.select().from(schema.agentRuns);
    const rows = (conds.length ? base.where(and(...conds)) : base).orderBy(desc(schema.agentRuns.startedAt)).limit(200).all();
    return c.json({ runs: rows });
  });

  // Aggregates answering the §8 use cases (cost/day, per-agent, success rate,
  // p95/long-running). Computed in JS over the last 14 days — low volume.
  app.get('/api/dashboard/agents/aggregates', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const project = c.req.query('project');
    const since = new Date(Date.now() - 14 * 86400_000);
    const conds = [gte(schema.agentRuns.startedAt, since)];
    if (project) conds.push(eq(schema.agentRuns.projectId, project));
    const runs = db.select().from(schema.agentRuns).where(and(...conds)).all();

    const FAIL = new Set(['error', 'timeout', 'max_turns', 'abandoned']);
    const dayMap = new Map<string, number>();
    const agentMap = new Map<string, { runs: number; success: number; totalMs: number; cost: number }>();
    const durations: number[] = [];
    let totalCost = 0;
    let success = 0;
    for (const r of runs) {
      const day = new Date(r.startedAt).toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) ?? 0) + r.costUsd);
      const a = agentMap.get(r.agentName) ?? { runs: 0, success: 0, totalMs: 0, cost: 0 };
      a.runs++;
      if (!FAIL.has(r.status)) a.success++;
      a.totalMs += r.durationMs ?? 0;
      a.cost += r.costUsd;
      agentMap.set(r.agentName, a);
      if (r.durationMs) durations.push(r.durationMs);
      totalCost += r.costUsd;
      if (!FAIL.has(r.status)) success++;
    }
    durations.sort((x, y) => x - y);
    const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(0.95 * durations.length))] : 0;

    // 14-day cost series, zero-filled.
    const costPerDay: { day: string; cost: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
      costPerDay.push({ day, cost: Number((dayMap.get(day) ?? 0).toFixed(4)) });
    }

    return c.json({
      overall: {
        total_runs: runs.length,
        success_rate: runs.length ? Math.round((success / runs.length) * 100) : null,
        avg_duration_ms: runs.length ? Math.round(durations.reduce((s, d) => s + d, 0) / (durations.length || 1)) : 0,
        p95_duration_ms: p95,
        max_duration_ms: durations.length ? durations[durations.length - 1] : 0,
        total_cost: Number(totalCost.toFixed(4)),
      },
      cost_per_day: costPerDay,
      runs_per_agent: [...agentMap.entries()]
        .map(([name, a]) => ({ agent_name: name, runs: a.runs, success_rate: Math.round((a.success / a.runs) * 100), avg_duration_ms: Math.round(a.totalMs / a.runs), cost: Number(a.cost.toFixed(4)) }))
        .sort((x, y) => y.runs - x.runs),
    });
  });

  // Single run detail (tool calls + token breakdown).
  app.get('/api/dashboard/agents/run/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const run = getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.id, c.req.param('id'))).get();
    if (!run) return c.json({ error: 'not_found' }, 404);
    return c.json({ run });
  });

  // Session view — all runs sharing a session_id, oldest first.
  app.get('/api/dashboard/agents/session/:sid', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const runs = getDb()
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.sessionId, c.req.param('sid')))
      .orderBy(schema.agentRuns.startedAt)
      .all();
    return c.json({ runs });
  });

  // Fake-crash trigger (F009.1 dogfood) — session-gated. Throws so app.onError
  // captures it to the upmetrics self-project.
  app.get('/api/debug/boom', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    throw new Error('Dogfood test crash 💥 — triggered from /api/debug/boom');
  });

  // ── Probes (F006.5) ───────────────────────────────────────────────────────
  // Grid — each probe + its last 20 results (for the sparkline).
  app.get('/api/dashboard/probes', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const probes = db.select().from(schema.probes).all();
    const rows = probes.map((p) => {
      const recent = db
        .select({ ok: schema.probeResults.ok, responseMs: schema.probeResults.responseMs, checkedAt: schema.probeResults.checkedAt })
        .from(schema.probeResults)
        .where(eq(schema.probeResults.probeId, p.id))
        .orderBy(desc(schema.probeResults.checkedAt))
        .limit(20)
        .all();
      return { ...p, recent: recent.reverse() };
    });
    return c.json({ probes: rows });
  });

  // Probe detail — full result history (last 100).
  app.get('/api/dashboard/probes/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'not_found' }, 404);
    const history = db
      .select()
      .from(schema.probeResults)
      .where(eq(schema.probeResults.probeId, probe.id))
      .orderBy(desc(schema.probeResults.checkedAt))
      .limit(100)
      .all();
    const lastFailure = db
      .select()
      .from(schema.probeResults)
      .where(and(eq(schema.probeResults.probeId, probe.id), eq(schema.probeResults.ok, false)))
      .orderBy(desc(schema.probeResults.checkedAt))
      .get();
    return c.json({ probe, history: history.reverse(), last_failure: lastFailure ?? null });
  });

  // Pause / resume — toggles the cronjobs trigger job.
  app.post('/api/dashboard/probes/:id/pause', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'not_found' }, 404);
    if (probe.cronjobsJobId) await setProbeJobEnabled(probe.cronjobsJobId, false).catch(() => {});
    db.update(schema.probes).set({ status: 'paused' }).where(eq(schema.probes.id, probe.id)).run();
    return c.json({ ok: true });
  });
  app.post('/api/dashboard/probes/:id/resume', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'not_found' }, 404);
    if (probe.cronjobsJobId) await setProbeJobEnabled(probe.cronjobsJobId, true).catch(() => {});
    db.update(schema.probes).set({ status: 'up' }).where(eq(schema.probes.id, probe.id)).run();
    return c.json({ ok: true });
  });
  // Edit (F006.5) — update name/target/interval/config in place. On interval or
  // name change, re-sync the cronjobs trigger job (no delete/recreate). The
  // config.runToken is preserved so the run endpoint keeps authenticating.
  app.post('/api/dashboard/probes/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'not_found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { name?: string; target?: string; interval_seconds?: number; config?: Record<string, unknown> };
    const set: Record<string, unknown> = {};
    if (typeof b.name === 'string' && b.name.trim()) set.name = b.name.trim();
    if (typeof b.target === 'string' && b.target.trim()) set.target = b.target.trim();
    let intervalChanged = false;
    if (b.interval_seconds !== undefined) {
      const iv = Number(b.interval_seconds);
      if (!Number.isInteger(iv) || iv < 60) return c.json({ error: 'interval_seconds must be an integer >= 60' }, 400);
      intervalChanged = iv !== probe.intervalSeconds;
      set.intervalSeconds = iv;
    }
    if (b.config && typeof b.config === 'object') {
      const prev = (probe.config ?? {}) as Record<string, unknown>;
      set.config = { ...prev, ...b.config, runToken: prev.runToken }; // never drop the run token
    }
    if (Object.keys(set).length === 0) return c.json({ error: 'no_fields' }, 400);
    db.update(schema.probes).set(set).where(eq(schema.probes.id, probe.id)).run();
    if (probe.cronjobsJobId && (set.name !== undefined || intervalChanged)) {
      try {
        await updateProbeJob(probe.cronjobsJobId, { name: set.name as string | undefined, intervalSeconds: intervalChanged ? (set.intervalSeconds as number) : undefined });
      } catch (err) {
        return c.json({ ok: true, cronjobs_synced: false, error: (err as Error).message }, 502);
      }
    }
    return c.json({ ok: true, cronjobs_synced: true });
  });

  // Delete — cascades to cronjobs job + result history (F004).
  app.delete('/api/dashboard/probes/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const probe = db.select().from(schema.probes).where(eq(schema.probes.id, c.req.param('id'))).get();
    if (!probe) return c.json({ error: 'not_found' }, 404);
    if (probe.cronjobsJobId) await deleteProbeJob(probe.cronjobsJobId).catch(() => {});
    db.delete(schema.probeResults).where(eq(schema.probeResults.probeId, probe.id)).run();
    db.delete(schema.probes).where(eq(schema.probes.id, probe.id)).run();
    return c.json({ ok: true });
  });

  // ── Incidents (F006.5) ────────────────────────────────────────────────────
  app.get('/api/dashboard/incidents', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const status = c.req.query('status');
    const base = db.select().from(schema.incidents);
    const rows = (status ? base.where(eq(schema.incidents.status, status)) : base).orderBy(desc(schema.incidents.openedAt)).limit(200).all();
    return c.json({ incidents: rows });
  });

  app.get('/api/dashboard/incidents/:id', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const incident = db.select().from(schema.incidents).where(eq(schema.incidents.id, c.req.param('id'))).get();
    if (!incident) return c.json({ error: 'not_found' }, 404);
    // trigger context: recent events for the project around the incident
    const events = db
      .select({ id: schema.events.id, kind: schema.events.kind, occurredAt: schema.events.occurredAt })
      .from(schema.events)
      .where(eq(schema.events.projectId, incident.projectId))
      .orderBy(desc(schema.events.receivedAt))
      .limit(10)
      .all();
    // has_webhook tells the modal which remediation path applies: the legacy
    // F005.3 webhook dispatch (only if a URL is configured) vs the F010 relay feed.
    const project = db.select({ webhook: schema.projects.remediationWebhookUrl }).from(schema.projects).where(eq(schema.projects.id, incident.projectId)).get();
    return c.json({ incident, trigger_events: events, has_webhook: Boolean(project?.webhook) });
  });

  app.post('/api/dashboard/incidents/:id/status', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const b = (await c.req.json().catch(() => ({}))) as { status?: string };
    const status = String(b.status ?? '');
    if (!['open', 'acknowledged', 'resolved'].includes(status)) return c.json({ error: 'bad_status' }, 400);
    const set: Record<string, unknown> = { status };
    if (status === 'resolved') set.resolvedAt = new Date();
    getDb().update(schema.incidents).set(set).where(eq(schema.incidents.id, c.req.param('id'))).run();
    return c.json({ ok: true });
  });

  // Re-run remediation. Two paths: the legacy F005.3 webhook dispatch ONLY when a
  // project has an external webhook configured; otherwise re-queue the incident
  // into the F010 relay feed Buddy polls (the live fleet path) — re-request + clear
  // any prior claim so a cc session picks it up again. No more dead-end 409.
  app.post('/api/dashboard/incidents/:id/remediate', async (c) => {
    if (!(await requireUser(c))) return c.json({ error: 'unauthorized' }, 401);
    const db = getDb();
    const incident = db.select().from(schema.incidents).where(eq(schema.incidents.id, c.req.param('id'))).get();
    if (!incident) return c.json({ error: 'not_found' }, 404);
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, incident.projectId)).get();
    if (project?.remediationWebhookUrl) {
      await dispatchRemediation(db, incident, project, new Date());
      return c.json({ ok: true, mode: 'webhook' });
    }
    db.update(schema.incidents)
      .set({ relayRequestedAt: new Date(), relayClaimedAt: null, relaySession: null, status: 'open', resolvedAt: null })
      .where(eq(schema.incidents.id, incident.id))
      .run();
    return c.json({ ok: true, mode: 'relay' });
  });
}
