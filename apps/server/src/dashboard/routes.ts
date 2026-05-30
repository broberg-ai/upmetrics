// Dashboard read API (F006). Thin, auth-gated read endpoints the SPA consumes.
// Business logic stays server-side; the SPA only renders. All routes require a
// valid Better Auth session (the dashboard cookie).
import type { Context, Hono } from 'hono';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
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
}
