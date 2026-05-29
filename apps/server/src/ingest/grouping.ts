// Error grouping (F002.2). Fingerprint = sha256(exception.type + normalized
// top stack frame); match-or-create an issue, bump counts, reopen if resolved.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { schema } from '../db';

type SentryPayload = Record<string, any>;

export function computeFingerprint(payload: SentryPayload): string {
  const exc = payload?.exception?.values?.[0];
  let key: string;
  if (exc) {
    const frames = (exc.stacktrace?.frames ?? []) as any[];
    const top = frames[frames.length - 1];
    const frame = top ? `${top.function ?? ''}@${top.filename ?? top.module ?? ''}` : '';
    key = `${exc.type ?? 'Error'}|${frame}`;
  } else {
    const msg = payload?.message ?? payload?.logentry?.message ?? 'unknown';
    key = `message|${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  }
  return createHash('sha256').update(key).digest('hex');
}

function titleAndCulprit(payload: SentryPayload): { title: string; culprit: string | null } {
  const exc = payload?.exception?.values?.[0];
  if (exc) {
    const title = `${exc.type ?? 'Error'}: ${exc.value ?? ''}`.trim();
    const frames = (exc.stacktrace?.frames ?? []) as any[];
    const top = frames[frames.length - 1];
    const culprit = top ? `${top.function ?? '?'} (${top.filename ?? top.module ?? '?'})` : null;
    return { title, culprit };
  }
  const msg = payload?.message ?? payload?.logentry?.message;
  return { title: typeof msg === 'string' && msg ? msg : 'Event', culprit: null };
}

// Upsert the issue for this event and return its id. Caller stamps the event's
// issue_id with the return value. Synchronous (bun:sqlite) — fast enough inline.
export function groupEvent(db: Db, projectId: string, payload: SentryPayload, occurredAt: Date): string {
  const fingerprint = computeFingerprint(payload);
  const hasUser = Boolean(payload?.user?.id ?? payload?.user?.email);

  const existing = db
    .select()
    .from(schema.issues)
    .where(and(eq(schema.issues.projectId, projectId), eq(schema.issues.fingerprint, fingerprint)))
    .get();

  if (existing) {
    const lastSeen = occurredAt > existing.lastSeen ? occurredAt : existing.lastSeen;
    db.update(schema.issues)
      .set({
        lastSeen,
        eventCount: existing.eventCount + 1,
        // NOTE: approximate — increments when an event carries a user; true
        // distinct-user dedup is deferred (needs a per-issue user set).
        userCount: existing.userCount + (hasUser ? 1 : 0),
        // Reopen a resolved issue when it recurs (PLAN F03).
        status: existing.status === 'resolved' ? 'unresolved' : existing.status,
      })
      .where(eq(schema.issues.id, existing.id))
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  const { title, culprit } = titleAndCulprit(payload);
  db.insert(schema.issues)
    .values({
      id,
      projectId,
      fingerprint,
      title,
      culprit,
      status: 'unresolved',
      level: typeof payload?.level === 'string' ? payload.level : 'error',
      firstSeen: occurredAt,
      lastSeen: occurredAt,
      eventCount: 1,
      userCount: hasUser ? 1 : 0,
    })
    .run();
  return id;
}
