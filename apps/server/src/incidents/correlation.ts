// Incident correlation worker (F005.1). On a ~30s tick it derives error_spike
// and agent_failure_spike signals from raw data, correlates them with open
// probe_down incidents and recent deploys, and upserts `incidents` rows with
// dynamic severity. upmetrics NEVER executes anything here — it only writes
// incident rows; alerting (F005.2) and remediation (F005.3) read from these.
//
// Signal derivation (Phase 1 has no separate signals/deploys tables):
//   error_spike          — >= ERROR_SPIKE_THRESHOLD `error` events in the window
//   agent_failure_spike  — >= AGENT_FAILURE_SPIKE_THRESHOLD failed agent_runs
//   recent deploy        — a release whose first-ever event is inside the window
//                          (events.release first-seen is the deploy proxy)
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';
import { runAlertsStorm } from './storm';
import { runRemediation } from './remediation';

type Db = ReturnType<typeof getDb>;
type Severity = 'critical' | 'high' | 'medium' | 'low';

// agent_runs statuses that count as a failure for the spike signal.
const AGENT_FAILURE_STATUSES = ['error', 'timeout'];

export interface CorrelationResult {
  scannedProjects: number;
  opened: number;
  updated: number;
  resolved: number;
}

export function runCorrelation(db: Db, now: Date = new Date()): CorrelationResult {
  const windowStart = new Date(now.getTime() - config.spikeWindowMs);
  const r: CorrelationResult = { scannedProjects: 0, opened: 0, updated: 0, resolved: 0 };

  for (const { id: projectId } of db.select({ id: schema.projects.id }).from(schema.projects).all()) {
    r.scannedProjects++;

    const errorCount = countErrors(db, projectId, windowStart);
    const errorSpike = errorCount >= config.errorSpikeThreshold;
    const agentFailCount = countAgentFailures(db, projectId, windowStart);
    const agentFailureSpike = agentFailCount >= config.agentFailureSpikeThreshold;
    const recentDeploy = recentRelease(db, projectId, windowStart);

    const openProbeDown = db
      .select()
      .from(schema.incidents)
      .where(
        and(
          eq(schema.incidents.projectId, projectId),
          eq(schema.incidents.kind, 'probe_down'),
          eq(schema.incidents.status, 'open'),
        ),
      )
      .all();

    // (1) probe_down + error_spike → MERGE: annotate the probe_down incident and
    // escalate to critical (no duplicate error_spike incident). De-escalate when
    // the error_spike clears while the probe is still down.
    for (const inc of openProbeDown) {
      const ev = (inc.eventsAtOpen ?? {}) as Record<string, unknown>;
      const correlated = new Set(Array.isArray(ev.correlated) ? (ev.correlated as string[]) : []);
      if (errorSpike && (!correlated.has('error_spike') || inc.severity !== 'critical')) {
        correlated.add('error_spike');
        db.update(schema.incidents)
          .set({ severity: 'critical', eventsAtOpen: { ...ev, correlated: [...correlated], error_count: errorCount } })
          .where(eq(schema.incidents.id, inc.id))
          .run();
        r.updated++;
      } else if (!errorSpike && correlated.has('error_spike')) {
        correlated.delete('error_spike');
        db.update(schema.incidents)
          .set({ severity: 'high', eventsAtOpen: { ...ev, correlated: [...correlated] } })
          .where(eq(schema.incidents.id, inc.id))
          .run();
        r.updated++;
      }
    }

    // (2) error_spike on its own (no open probe_down) → its own incident.
    if (errorSpike && openProbeDown.length === 0) {
      const sev: Severity = errorCount >= config.errorSpikeThreshold * 3 ? 'high' : 'medium';
      bump(r, upsertSpike(db, projectId, 'error_spike', `Error spike — ${errorCount} errors in window`, sev, { error_count: errorCount }, now));
    } else if (!errorSpike) {
      r.resolved += resolveOpen(db, projectId, 'error_spike', now);
    }

    // (3) agent_failure_spike, escalated + tagged when it follows a recent deploy.
    if (agentFailureSpike) {
      const sev: Severity = recentDeploy ? 'high' : 'medium';
      const meta: Record<string, unknown> = { failure_count: agentFailCount, correlated: recentDeploy ? ['recent_deploy'] : [] };
      if (recentDeploy) meta.recent_deploy = recentDeploy;
      const title = `Agent failure spike — ${agentFailCount} failures in window${recentDeploy ? ` after deploy ${recentDeploy}` : ''}`;
      bump(r, upsertSpike(db, projectId, 'agent_failure_spike', title, sev, meta, now));
    } else {
      r.resolved += resolveOpen(db, projectId, 'agent_failure_spike', now);
    }
  }

  return r;
}

// ── signal queries ──────────────────────────────────────────────────────────
function countErrors(db: Db, projectId: string, since: Date): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.events)
      .where(and(eq(schema.events.projectId, projectId), eq(schema.events.kind, 'error'), gte(schema.events.receivedAt, since)))
      .get()?.n ?? 0
  );
}

function countAgentFailures(db: Db, projectId: string, since: Date): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.projectId, projectId),
          inArray(schema.agentRuns.status, AGENT_FAILURE_STATUSES),
          gte(schema.agentRuns.startedAt, since),
        ),
      )
      .get()?.n ?? 0
  );
}

// A release counts as a recent deploy if its earliest event is inside the window.
function recentRelease(db: Db, projectId: string, since: Date): string | null {
  const row = db
    .select({ release: schema.events.release, firstSeen: sql<number>`min(received_at)` })
    .from(schema.events)
    .where(and(eq(schema.events.projectId, projectId), sql`release is not null`))
    .groupBy(schema.events.release)
    .having(gte(sql<number>`min(received_at)`, since.getTime()))
    .get();
  return row?.release ?? null;
}

// ── incident upsert / resolve ─────────────────────────────────────────────────
// One open incident per (project, kind); update it in place rather than spawning
// duplicates. Returns what happened so the caller can tally.
function upsertSpike(
  db: Db,
  projectId: string,
  kind: 'error_spike' | 'agent_failure_spike',
  title: string,
  severity: Severity,
  meta: Record<string, unknown>,
  now: Date,
): 'opened' | 'updated' | 'noop' {
  const open = db
    .select()
    .from(schema.incidents)
    .where(and(eq(schema.incidents.projectId, projectId), eq(schema.incidents.kind, kind), eq(schema.incidents.status, 'open')))
    .get();

  if (!open) {
    db.insert(schema.incidents)
      .values({
        id: crypto.randomUUID(),
        projectId,
        kind,
        status: 'open',
        severity,
        title,
        openedAt: now,
        triggerRef: `${kind}:${projectId}`,
        eventsAtOpen: meta,
      })
      .run();
    return 'opened';
  }

  if (open.severity !== severity || open.title !== title) {
    db.update(schema.incidents).set({ severity, title, eventsAtOpen: meta }).where(eq(schema.incidents.id, open.id)).run();
    return 'updated';
  }
  return 'noop';
}

function resolveOpen(db: Db, projectId: string, kind: 'error_spike' | 'agent_failure_spike', now: Date): number {
  const open = db
    .select()
    .from(schema.incidents)
    .where(and(eq(schema.incidents.projectId, projectId), eq(schema.incidents.kind, kind), eq(schema.incidents.status, 'open')))
    .all();
  for (const inc of open) {
    db.update(schema.incidents).set({ status: 'resolved', resolvedAt: now }).where(eq(schema.incidents.id, inc.id)).run();
  }
  return open.length;
}

function bump(r: CorrelationResult, outcome: 'opened' | 'updated' | 'noop'): void {
  if (outcome === 'opened') r.opened++;
  else if (outcome === 'updated') r.updated++;
}

// ── worker loop ───────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;

export function startCorrelationWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const db = getDb();
      runCorrelation(db); // F005.1 — derive/correlate incidents (sync)
      void runAlertsStorm(db).catch((err) => console.error('[alerts] tick failed:', err)); // F005.2 + F008.3 storm-control
      void runRemediation(db).catch((err) => console.error('[remediation] tick failed:', err)); // F005.3 — dispatch
    } catch (err) {
      console.error('[correlation] tick failed:', err);
    }
  }, config.correlationIntervalMs);
  // Don't keep the process alive solely for this timer.
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
}
