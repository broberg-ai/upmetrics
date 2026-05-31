// F010 — auto-remediation relay (PULL model). Buddy runs locally (Tailscale, not
// cloud), so upmetrics can't push to it. Instead upmetrics exposes a feed of
// remediation-eligible incidents that Buddy's orchestrator polls outbound, then
// claims after relaying to the responsible repo's live cc session. Regression
// (error recurs in a newer release) re-surfaces an incident automatically.
import type { Context, Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
// Only code-fixable error incidents — NOT probe_down (infra, not a session's bug).
const ERROR_KINDS = new Set(['error_spike', 'agent_failure_spike']);

// repo basename → absolute path (local to Christian's Mac). Buddy resolves
// repo→path via its own repos table; repo_path is a best-effort hint.
const REPO_PATHS: Record<string, string> = {
  'fysiodk-aalborg-sport': '/Users/cb/Apps/webhouse/fysiodk-aalborg-sport',
  cms: '/Users/cb/Apps/webhouse/cms',
  sanneandersen: '/Users/cb/Apps/webhouse/sanneandersen',
  trail: '/Users/cb/Apps/broberg/trail',
  xrt81: '/Users/cb/Apps/broberg/xrt81',
  cardmem: '/Users/cb/Apps/broberg/cardmem',
};

export interface RemediationItem {
  incident_id: string;
  project: string;
  repo: string;
  repo_path: string | null;
  severity: string;
  opened_at: Date;
  issue: {
    id: string;
    title: string;
    culprit: string | null;
    level: string;
    release: string | null;
    occurrences: number;
    top_stack_frames: Array<Record<string, unknown>>;
    dashboard_url: string;
  };
}

// Eligible = open + error-kind + severity≥threshold + project opted-in (with a
// repo) + not yet claimed. Cheap: indexed status filter + per-incident lookups.
export function pendingRemediations(db: Db): RemediationItem[] {
  const open = db
    .select()
    .from(schema.incidents)
    .where(and(eq(schema.incidents.status, 'open'), isNull(schema.incidents.relayClaimedAt)))
    .all();

  const out: RemediationItem[] = [];
  const minRank = SEVERITY_RANK[config.remediationRelaySeverity] ?? 3;
  for (const inc of open) {
    if (!ERROR_KINDS.has(inc.kind)) continue;
    if ((SEVERITY_RANK[inc.severity] ?? 0) < minRank) continue;
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, inc.projectId)).get();
    if (!project?.remediationRelay || !project.repo) continue;
    // error incidents carry the issue id in trigger_ref.
    const issue = db.select().from(schema.issues).where(eq(schema.issues.id, inc.triggerRef)).get();
    if (!issue) continue;
    const ev = db
      .select({ release: schema.events.release, payload: schema.events.payload })
      .from(schema.events)
      .where(eq(schema.events.issueId, issue.id))
      .orderBy(desc(schema.events.receivedAt))
      .limit(1)
      .get();
    const payload = (ev?.payload ?? {}) as {
      exception?: { values?: Array<{ stacktrace?: { frames?: Array<Record<string, unknown>> } }> };
    };
    // SDK orders frames oldest-first (crashing frame last) → the last few are the
    // most relevant.
    const allFrames = payload.exception?.values?.[0]?.stacktrace?.frames ?? [];
    out.push({
      incident_id: inc.id,
      project: project.id,
      repo: project.repo,
      repo_path: REPO_PATHS[project.repo] ?? null,
      severity: inc.severity,
      opened_at: inc.openedAt,
      issue: {
        id: issue.id,
        title: issue.title,
        culprit: issue.culprit,
        level: issue.level,
        release: ev?.release ?? null,
        occurrences: issue.eventCount,
        top_stack_frames: allFrames.slice(-5),
        dashboard_url: `${config.authBaseUrl}/issues/${issue.id}`,
      },
    });
  }
  return out;
}

export interface ClaimResult {
  ok: boolean;
  alreadyClaimed: boolean;
}

// Idempotent: re-claiming an already-claimed incident is a 200 no-op.
export function claimRemediation(db: Db, incidentId: string, session: string, now: Date = new Date()): ClaimResult {
  const inc = db.select().from(schema.incidents).where(eq(schema.incidents.id, incidentId)).get();
  if (!inc) return { ok: false, alreadyClaimed: false };
  if (inc.relayClaimedAt) return { ok: true, alreadyClaimed: true };
  db.update(schema.incidents)
    .set({ relayClaimedAt: now, relaySession: session })
    .where(eq(schema.incidents.id, incidentId))
    .run();
  return { ok: true, alreadyClaimed: false };
}

// Eligible incidents that have stayed unclaimed past the escalation window —
// these have no live cc session to fix them, so upmetrics escalates to Christian.
export function unclaimedEscalations(db: Db, now: Date = new Date()): RemediationItem[] {
  const cutoff = now.getTime() - config.remediationEscalateMs;
  return pendingRemediations(db).filter((r) => r.opened_at.getTime() < cutoff);
}

// ── routes (Buddy's local poll-loop consumes these, outbound) ────────────────
function authed(c: Context): boolean {
  const token = config.remediationRelayToken;
  if (!token) return false; // disabled until a token is configured
  const auth = c.req.header('authorization') ?? '';
  return auth === `Bearer ${token}`;
}

export function registerRemediationRoutes(app: Hono): void {
  app.get('/api/remediation/pending', (c) => {
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ incidents: pendingRemediations(getDb()) });
  });

  app.post('/api/remediation/:incidentId/claim', async (c) => {
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { session?: string };
    if (!body.session) return c.json({ error: 'session required' }, 400);
    const res = claimRemediation(getDb(), c.req.param('incidentId'), body.session);
    if (!res.ok) return c.json({ error: 'unknown_incident' }, 404);
    return c.json({ ok: true, already_claimed: res.alreadyClaimed });
  });
}
