// F010 — auto-remediation relay (PULL model). Buddy runs locally (Tailscale, not
// cloud), so upmetrics can't push to it. Instead upmetrics exposes a feed of
// remediation-eligible incidents that Buddy's orchestrator polls outbound, then
// claims after relaying to the responsible repo's live cc session. Regression
// (error recurs in a newer release) re-surfaces an incident automatically.
import type { Context, Hono } from 'hono';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { verifyClaim } from './cardmem-push';

type Db = ReturnType<typeof getDb>;
const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
// Only code-fixable error incidents — NOT probe_down (infra, not a session's bug).
// 'manual_remediation' = a user pushed an issue here on demand (F010.4).
const ERROR_KINDS = new Set(['error_spike', 'agent_failure_spike', 'manual_remediation']);

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
  manual: boolean;
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
  for (const inc of open) {
    if (!ERROR_KINDS.has(inc.kind)) continue;
    // A manual push (relayRequestedAt set) is explicit user intent — it bypasses
    // the auto severity threshold and per-project opt-in gates.
    const manual = Boolean(inc.relayRequestedAt);
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, inc.projectId)).get();
    if (!project) continue;
    if (!manual && (!project.remediationRelay || !project.repo)) continue;
    // F010.5 — per-project severity gate (null → global config default).
    const minRank = SEVERITY_RANK[project.remediationRelaySeverity ?? config.remediationRelaySeverity] ?? 3;
    if (!manual && (SEVERITY_RANK[inc.severity] ?? 0) < minRank) continue;
    const repo = project.repo ?? project.id;
    // Resolve the representative issue. Some incidents carry an issue id in
    // trigger_ref; correlation-opened spikes use "kind:project" (NOT an issue id)
    // — for those, surface the project's most-recent unresolved issue so the
    // relay still carries a concrete title/culprit/stack.
    let issue = db.select().from(schema.issues).where(eq(schema.issues.id, inc.triggerRef)).get();
    if (!issue) {
      issue = db
        .select()
        .from(schema.issues)
        .where(and(eq(schema.issues.projectId, inc.projectId), eq(schema.issues.status, 'unresolved')))
        .orderBy(desc(schema.issues.lastSeen))
        .limit(1)
        .get();
    }
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
      repo,
      repo_path: REPO_PATHS[repo] ?? null,
      severity: inc.severity,
      manual,
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

// ── F010.5: self-service remediation enrollment ──────────────────────────────
// A repo manages its OWN remediation enrollment with its project api_key
// (X-Upmetrics-Key — the same key as cost-ingest), and the dashboard reuses the
// SAME helpers under session auth. Single write path → no drift between the two.
type ProjectRow = typeof schema.projects.$inferSelect;
const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

export function enrollmentView(p: ProjectRow) {
  return {
    project: p.id,
    enabled: p.remediationRelay,
    repo: p.repo,
    github_repo: p.githubRepo,
    severity: p.remediationRelaySeverity, // null = inherit the global default
    effective_severity: p.remediationRelaySeverity ?? config.remediationRelaySeverity,
  };
}

type EnrollmentPatch = Partial<Pick<ProjectRow, 'remediationRelay' | 'repo' | 'githubRepo' | 'remediationRelaySeverity'>>;

// Validate + map a request body to a partial projects update (only present keys
// are touched). Returns {error} on a bad severity so the caller can 400.
export function buildEnrollmentPatch(body: Record<string, unknown>): EnrollmentPatch | { error: string; allowed: string[] } {
  const patch: EnrollmentPatch = {};
  if ('enabled' in body) patch.remediationRelay = Boolean(body.enabled);
  if ('repo' in body) patch.repo = body.repo ? String(body.repo).trim() : null;
  if ('github_repo' in body) patch.githubRepo = body.github_repo ? String(body.github_repo).trim() : null;
  if ('severity' in body) {
    const s = body.severity;
    if (s === null || s === '') patch.remediationRelaySeverity = null;
    else if (typeof s === 'string' && SEVERITIES.has(s)) patch.remediationRelaySeverity = s;
    else return { error: 'invalid_severity', allowed: [...SEVERITIES] };
  }
  return patch;
}

export function applyEnrollment(db: Db, projectId: string, patch: EnrollmentPatch): ReturnType<typeof enrollmentView> {
  db.update(schema.projects).set({ ...patch, updatedAt: new Date() }).where(eq(schema.projects.id, projectId)).run();
  return enrollmentView(db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()!);
}

function projectFromKey(c: Context): ProjectRow | null {
  const key = c.req.header('x-upmetrics-key');
  if (!key) return null;
  return getDb().select().from(schema.projects).where(eq(schema.projects.apiKey, key)).get() ?? null;
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
    const incidentId = c.req.param('incidentId');
    // Two auth paths: (a) Bearer relay-token + body.session (Buddy's poll-loop),
    // or (b) a signed ?t= claim token (cardmem's callback — no token needed). F005.4.
    const t = c.req.query('t');
    let session: string;
    if (t) {
      if (!verifyClaim(incidentId, t)) return c.json({ error: 'invalid_claim_token' }, 401);
      session = 'cardmem';
    } else {
      if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
      const body = (await c.req.json().catch(() => ({}))) as { session?: string };
      if (!body.session) return c.json({ error: 'session required' }, 400);
      session = body.session;
    }
    const res = claimRemediation(getDb(), incidentId, session);
    if (!res.ok) return c.json({ error: 'unknown_incident' }, 404);
    return c.json({ ok: true, already_claimed: res.alreadyClaimed });
  });

  // F010.5 — self-service enrollment. A repo reads/sets its OWN remediation
  // config with its project key (X-Upmetrics-Key, same key as cost-ingest).
  app.get('/api/remediation/enrollment', (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    return c.json(enrollmentView(project));
  });

  app.put('/api/remediation/enrollment', async (c) => {
    const project = projectFromKey(c);
    if (!project) return c.json({ error: 'invalid_api_key' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch = buildEnrollmentPatch(body);
    if ('error' in patch) return c.json(patch, 400);
    return c.json(applyEnrollment(getDb(), project.id, patch));
  });
}
