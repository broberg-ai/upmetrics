// Remediation dispatcher (F005.3). On the incident worker tick: for each OPEN
// incident at/above the configured severity threshold whose project has a
// remediation_webhook_url, POST a HMAC-signed payload (incident + recent
// context + a remediation_token for callback auth), retry 3x with backoff, and
// log every attempt to incidents.remediation_attempts. Dispatched once per
// incident (dedup: skip if remediation_attempts already set).
//
// upmetrics NEVER executes anything — it only calls the configured webhook. The
// receiver (e.g. cardmem) decides what to do and may POST back to the callback.
import { createHmac } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
const SEVERITY_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export interface RemediationResult {
  scanned: number;
  dispatched: number;
}

export async function runRemediation(db: Db, now: Date = new Date()): Promise<RemediationResult> {
  const r: RemediationResult = { scanned: 0, dispatched: 0 };
  const threshold = SEVERITY_RANK[config.remediationThreshold] ?? 2;
  const open = db.select().from(schema.incidents).where(eq(schema.incidents.status, 'open')).all();

  for (const inc of open) {
    if ((SEVERITY_RANK[inc.severity] ?? 0) < threshold) continue;
    if (inc.remediationAttempts) continue; // already dispatched — dedup
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, inc.projectId)).get();
    if (!project?.remediationWebhookUrl) continue;
    r.scanned++;
    await dispatch(db, inc, project, now);
    r.dispatched++;
  }
  return r;
}

type Incident = typeof schema.incidents.$inferSelect;
type Project = typeof schema.projects.$inferSelect;

async function dispatch(db: Db, incident: Incident, project: Project, now: Date): Promise<void> {
  const token = crypto.randomUUID().replace(/-/g, '');
  const recentEvents = db
    .select({ id: schema.events.id, kind: schema.events.kind, occurredAt: schema.events.occurredAt, issueId: schema.events.issueId })
    .from(schema.events)
    .where(eq(schema.events.projectId, project.id))
    .orderBy(desc(schema.events.receivedAt))
    .limit(10)
    .all();
  const recentRuns = db
    .select({ id: schema.agentRuns.id, agentName: schema.agentRuns.agentName, status: schema.agentRuns.status, costUsd: schema.agentRuns.costUsd })
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.projectId, project.id))
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(10)
    .all();

  const callbackUrl = `${config.authBaseUrl}/api/incidents/${incident.id}/remediation-callback`;
  const payload = {
    incident: {
      id: incident.id,
      project_id: incident.projectId,
      kind: incident.kind,
      severity: incident.severity,
      title: incident.title,
      opened_at: incident.openedAt,
    },
    remediation_token: token,
    callback_url: callbackUrl,
    recent_events: recentEvents,
    recent_agent_runs: recentRuns,
  };
  const body = JSON.stringify(payload);
  const signature = createHmac('sha256', project.remediationWebhookSecret ?? '').update(body).digest('hex');

  const attempts: Array<Record<string, unknown>> = [];
  let delivered = false;
  for (let i = 0; i < config.remediationRetries; i++) {
    const at = new Date().toISOString();
    try {
      const res = await fetch(project.remediationWebhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-upmetrics-signature': `sha256=${signature}` },
        body,
      });
      attempts.push({ at, attempt: i + 1, status: res.status, ok: res.ok });
      if (res.ok) {
        delivered = true;
        break;
      }
    } catch (err) {
      attempts.push({ at, attempt: i + 1, error: err instanceof Error ? err.message : String(err) });
    }
    if (i < config.remediationRetries - 1) await sleep(config.remediationBackoffMs * 2 ** i);
  }

  db.update(schema.incidents)
    .set({ remediationAttempts: { token, callback_url: callbackUrl, delivered, attempts, callbacks: [] } })
    .where(eq(schema.incidents.id, incident.id))
    .run();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
