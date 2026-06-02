// F005.4 — push error-incidents to cardmem's Inbox as durable triage cards.
// PUSH model (cardmem F067): POST services.cardmem.com/api/incidents with a
// per-project Bearer key; cardmem dedups on `fingerprint` and calls back our
// signed `claim_url` once carded (→ incident drops out of /pending). Complements
// the F010 Buddy-pull relay (live auto-fix); this is the visible triage lane.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
const ERROR_KINDS = new Set(['error_spike', 'agent_failure_spike', 'manual_remediation']);

// HMAC(incident_id) with the relay token → a tamper-proof claim token so cardmem
// can POST claim_url without ever holding REMEDIATION_RELAY_TOKEN. `secret` is
// injectable for tests; defaults to the configured relay token.
export function signClaim(incidentId: string, secret: string = config.remediationRelayToken): string {
  return createHmac('sha256', secret).update(incidentId).digest('hex');
}
export function verifyClaim(incidentId: string, token: string | undefined | null, secret: string = config.remediationRelayToken): boolean {
  if (!token || !secret) return false;
  const a = Buffer.from(signClaim(incidentId, secret));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Incident = typeof schema.incidents.$inferSelect;
type Issue = typeof schema.issues.$inferSelect;
type Project = typeof schema.projects.$inferSelect;

// Open, error-kind incidents for the cardmem-target projects that haven't been
// pushed yet. The cardmem_pushed_at guard is the one-push-per-incident flood lock.
function pendingCardmemPush(db: Db, projects: string[]): Array<{ inc: Incident; project: Project; issue: Issue | undefined }> {
  if (!projects.length) return [];
  const rows = db
    .select()
    .from(schema.incidents)
    .where(
      and(
        eq(schema.incidents.status, 'open'),
        isNull(schema.incidents.cardmemPushedAt),
        inArray(schema.incidents.projectId, projects),
      ),
    )
    .all();
  const out: Array<{ inc: Incident; project: Project; issue: Issue | undefined }> = [];
  for (const inc of rows) {
    if (!ERROR_KINDS.has(inc.kind)) continue;
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, inc.projectId)).get();
    if (!project) continue;
    // Resolve the representative issue (triggerRef, else latest unresolved) — same
    // as the Buddy relay feed, so the card carries a concrete culprit/title.
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
    out.push({ inc, project, issue });
  }
  return out;
}

export function buildIncidentBody(inc: Incident, project: Project, issue: Issue | undefined) {
  const detail = [
    issue?.culprit ? `**Culprit:** \`${issue.culprit}\`` : '',
    issue ? `**Level:** ${issue.level} · **Occurrences:** ${issue.eventCount}` : '',
    `**Kind:** ${inc.kind} · **Severity:** ${inc.severity}`,
    `**Opened:** ${inc.openedAt.toISOString()}`,
    `\n[Open in upmetrics →](${config.authBaseUrl}/incidents?id=${inc.id})`,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    fingerprint: inc.id, // stable per incident; cardmem bumps a repeat, never dups
    title: inc.title || issue?.title || `${project.id} incident`,
    severity: inc.severity,
    source: 'upmetrics' as const,
    detail,
    url: `${config.authBaseUrl}/incidents?id=${inc.id}`,
    incident_id: inc.id,
    claim_url: `${config.authBaseUrl}/api/remediation/${inc.id}/claim?t=${signClaim(inc.id)}`,
    github_repo_full_name: project.repo ?? undefined, // sanity-check; the key routes
  };
}

export interface PushOpts {
  fetchFn?: typeof fetch;
  now?: Date;
  url?: string;
  key?: string;
  projects?: string[];
}

// Push each pending incident once. On a 200, stamp cardmem_pushed_at so it's never
// re-pushed. Errors are logged + non-fatal (we retry it next tick, still one card
// per incident because cardmem dedups on fingerprint until we record the stamp).
// Config (url/key/projects) is injectable for tests; defaults to the global config.
export async function pushPendingToCardmem(db: Db, opts: PushOpts = {}): Promise<number> {
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? new Date();
  const url = opts.url ?? config.cardmemIncidentsUrl;
  const key = opts.key ?? config.cardmemIncidentsKey;
  const projects = opts.projects ?? (config.cardmemPushProjects as string[]);
  if (!key) return 0; // disabled until the key is configured
  let pushed = 0;
  for (const { inc, project, issue } of pendingCardmemPush(db, projects)) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(buildIncidentBody(inc, project, issue)),
      });
      if (res.ok) {
        db.update(schema.incidents).set({ cardmemPushedAt: now }).where(eq(schema.incidents.id, inc.id)).run();
        pushed++;
      } else {
        console.error(`[cardmem-push] ${inc.id} → HTTP ${res.status}`);
      }
    } catch (err) {
      console.error(`[cardmem-push] ${inc.id} failed:`, err);
    }
  }
  return pushed;
}
