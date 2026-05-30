// Dashboard read API (F006). Thin, auth-gated read endpoints the SPA consumes.
// Business logic stays server-side; the SPA only renders. All routes require a
// valid Better Auth session (the dashboard cookie).
import type { Context, Hono } from 'hono';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { auth } from '../auth';

async function requireUser(c: Context): Promise<boolean> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  return Boolean(session?.user);
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
      },
    });
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
    return c.json({ issue, events, related_agent_runs: relatedRuns });
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
}
