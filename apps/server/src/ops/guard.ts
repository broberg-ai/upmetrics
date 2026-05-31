// F007.2 — per-project ingest guardrails. Enforces a rate limit (events/min) and
// a storage cap (max events), both read LIVE from the project row so changing a
// limit takes effect without a redeploy. Over-limit DROPS the incoming batch and
// emits exactly ONE warning event per window (never blocks or crashes ingest, and
// never silently loses data — the owner sees the warning in their project).
import { eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { config } from '../config';

type Db = ReturnType<typeof getDb>;
type Project = typeof schema.projects.$inferSelect;

// In-process state: rolling per-minute rate window + last-warning timestamp.
const rate = new Map<string, { windowStart: number; count: number }>();
const lastWarn = new Map<string, number>();
export function _resetGuardState(): void {
  rate.clear();
  lastWarn.clear();
}

export interface GuardDecision {
  accept: boolean;
  reason: 'ok' | 'rate' | 'storage';
}

// Decide whether to accept `itemCount` events for a project, recording the
// accepted count against the rate window. On rejection, emits one warning event
// per ingestWarnIntervalMs.
export function guardIngest(db: Db, project: Project, itemCount: number, now: number): GuardDecision {
  // Storage cap (indexed count by project_id).
  const total =
    db.select({ c: sql<number>`count(*)` }).from(schema.events).where(eq(schema.events.projectId, project.id)).get()
      ?.c ?? 0;
  if (total >= project.storageMaxEvents) {
    warnOnce(db, project, 'storage', now);
    return { accept: false, reason: 'storage' };
  }

  // Rate limit (rolling 60s window). A fresh window is still checked, so a
  // single oversized batch can't slip past the limit.
  const w = rate.get(project.id);
  const fresh = !w || now - w.windowStart >= 60_000;
  const projected = fresh ? itemCount : w!.count + itemCount;
  if (projected > project.rateLimitPerMin) {
    warnOnce(db, project, 'rate', now);
    return { accept: false, reason: 'rate' };
  }
  if (fresh) rate.set(project.id, { windowStart: now, count: itemCount });
  else w!.count += itemCount;
  return { accept: true, reason: 'ok' };
}

function warnOnce(db: Db, project: Project, reason: 'rate' | 'storage', now: number): void {
  const last = lastWarn.get(project.id) ?? 0;
  if (now - last < config.ingestWarnIntervalMs) return;
  lastWarn.set(project.id, now);
  const ts = new Date(now);
  db.insert(schema.events)
    .values({
      id: crypto.randomUUID().replace(/-/g, ''),
      projectId: project.id,
      kind: 'message',
      receivedAt: ts,
      occurredAt: ts,
      payload: {
        level: 'warning',
        message:
          reason === 'rate'
            ? `Ingest rate limit exceeded (${project.rateLimitPerMin}/min) — dropping new events`
            : `Storage cap reached (${project.storageMaxEvents} events) — dropping new events`,
        logger: 'upmetrics.guard',
      },
      issueId: null,
      release: null,
      environment: null,
      tags: { upmetrics_guard: reason },
    })
    .onConflictDoNothing()
    .run();
}
