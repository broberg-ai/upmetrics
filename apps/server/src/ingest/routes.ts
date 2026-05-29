// Sentry-compatible envelope ingest (F002.1). Validates the DSN public key,
// persists event/transaction/check_in items; drops attachment/session.
// Grouping (issue_id) is F002.2 — events land with issueId null here.
import type { Context, Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { parseEnvelope, extractPublicKey, type EnvelopeItem } from './envelope';
import { groupEvent } from './grouping';

// Item types we persist vs. drop (PLAN §7).
const STORED = new Set(['event', 'transaction', 'check_in']);
const DROPPED = new Set(['attachment', 'session']);

function sentryKey(c: Context): string | null {
  const q = c.req.query('sentry_key');
  if (q) return q;
  const auth = c.req.header('x-sentry-auth') ?? '';
  const m = auth.match(/sentry_key=([^,\s]+)/);
  return m ? (m[1] ?? null) : null;
}

function eventId(item: EnvelopeItem, envelopeHeaders: Record<string, unknown>): string {
  const p = item.payload as Record<string, unknown> | undefined;
  const fromPayload = p && typeof p['event_id'] === 'string' ? (p['event_id'] as string) : undefined;
  const fromHeader =
    typeof envelopeHeaders['event_id'] === 'string' ? (envelopeHeaders['event_id'] as string) : undefined;
  return fromPayload ?? fromHeader ?? crypto.randomUUID().replace(/-/g, '');
}

function occurredAt(item: EnvelopeItem): Date {
  const p = item.payload as Record<string, unknown> | undefined;
  const ts = p?.['timestamp'];
  if (typeof ts === 'number') return new Date(ts * 1000);
  if (typeof ts === 'string') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

export function registerIngestRoutes(app: Hono): void {
  app.post('/api/:projectId/envelope/', async (c) => {
    const projectId = c.req.param('projectId');
    const db = getDb();

    const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    if (!project) return c.json({ error: 'unknown_project' }, 404);

    const key = sentryKey(c);
    if (!key || extractPublicKey(project.dsn) !== key) {
      return c.json({ error: 'invalid_dsn' }, 401);
    }

    const raw = await c.req.text();
    const env = parseEnvelope(raw);

    let accepted = 0;
    let dropped = 0;
    const now = new Date();

    for (const item of env.items) {
      if (DROPPED.has(item.type)) {
        dropped++;
        continue;
      }
      if (!STORED.has(item.type)) {
        dropped++;
        continue;
      }
      const p = (item.payload ?? {}) as Record<string, unknown>;
      const occurred = occurredAt(item);
      // Only error events group into issues (F002.2). transaction/check_in store raw.
      const issueId = item.type === 'event' ? groupEvent(db, project.id, p, occurred) : null;
      db.insert(schema.events)
        .values({
          id: eventId(item, env.headers),
          projectId: project.id,
          kind: item.type === 'event' ? 'error' : item.type,
          receivedAt: now,
          occurredAt: occurred,
          payload: p,
          issueId,
          release: typeof p['release'] === 'string' ? (p['release'] as string) : null,
          environment: typeof p['environment'] === 'string' ? (p['environment'] as string) : null,
          tags: (p['tags'] as Record<string, string>) ?? null,
        })
        .onConflictDoNothing()
        .run();
      accepted++;
    }

    return c.json({ accepted, dropped });
  });
}
