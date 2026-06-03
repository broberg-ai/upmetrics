// F010.5 escalation. Run: bun test src/incidents/escalation.test.ts
import { describe, it, expect } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../db';
import { escalateUnclaimed } from './escalation';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const NOW = new Date('2026-06-03T12:00:00Z');
const PAST = new Date(NOW.getTime() - 60 * 60_000); // 60 min ago — past the 30m window
let seq = 0;

function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string, opts: Partial<typeof schema.projects.$inferInsert> = {}): void {
  db.insert(schema.projects)
    .values({ id, name: id, dsn: `https://k_${id}@upmetrics.org/${id}`, apiKey: `uk_${id}`, platform: 'web', createdAt: NOW, updatedAt: NOW, ...opts })
    .run();
}
function addIssue(db: Db, id: string, projectId: string): void {
  db.insert(schema.issues)
    .values({ id, projectId, fingerprint: `fp_${id}`, title: `boom ${id}`, culprit: 'src/x.ts', level: 'error', firstSeen: NOW, lastSeen: NOW, eventCount: 3 })
    .run();
}
function addIncident(db: Db, projectId: string, opts: Partial<typeof schema.incidents.$inferInsert> = {}): string {
  const id = `inc_${++seq}`;
  db.insert(schema.incidents)
    .values({ id, projectId, kind: 'error_spike', status: 'open', severity: 'high', title: 'error spike', openedAt: PAST, triggerRef: opts.triggerRef ?? 'iss_x', ...opts })
    .run();
  return id;
}

function spy() {
  const calls: Array<{ url: string; message: string; color: number }> = [];
  const send = async (url: string, message: string, color: number) => {
    calls.push({ url, message, color });
  };
  return { calls, send };
}

describe('escalateUnclaimed', () => {
  it('alerts once for an unclaimed incident past the window, stamps escalation_alerted_at', async () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss1', 'on');
    const id = addIncident(db, 'on', { triggerRef: 'iss1' }); // openedAt=PAST, unclaimed
    const { calls, send } = spy();

    const n = await escalateUnclaimed(db, { now: NOW, webhookUrl: 'https://discord.test', send });
    expect(n).toBe(1);
    expect(calls.length).toBe(1);
    expect(calls[0]!.message).toContain('boom iss1');
    expect(calls[0]!.message).toContain('unclaimed');
    expect(db.select().from(schema.incidents).where(eq(schema.incidents.id, id)).get()!.escalationAlertedAt).not.toBeNull();
  });

  it('is idempotent — a second tick does not re-alert (escalation_alerted_at dedup)', async () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss2', 'on');
    addIncident(db, 'on', { triggerRef: 'iss2' });
    const { calls, send } = spy();
    await escalateUnclaimed(db, { now: NOW, webhookUrl: 'x', send });
    const n2 = await escalateUnclaimed(db, { now: NOW, webhookUrl: 'x', send });
    expect(n2).toBe(0);
    expect(calls.length).toBe(1); // only the first
  });

  it('does not escalate a recent (within-window) incident', async () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss3', 'on');
    addIncident(db, 'on', { triggerRef: 'iss3', openedAt: NOW }); // fresh
    const { calls, send } = spy();
    expect(await escalateUnclaimed(db, { now: NOW, webhookUrl: 'x', send })).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('does not escalate a claimed incident', async () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss4', 'on');
    addIncident(db, 'on', { triggerRef: 'iss4', relayClaimedAt: NOW, relaySession: 'trail' });
    const { calls, send } = spy();
    expect(await escalateUnclaimed(db, { now: NOW, webhookUrl: 'x', send })).toBe(0);
    expect(calls.length).toBe(0);
  });

  it('does not stamp (so it retries) when the send fails', async () => {
    const db = freshDb();
    addProject(db, 'on', { remediationRelay: true, repo: 'on' });
    addIssue(db, 'iss5', 'on');
    const id = addIncident(db, 'on', { triggerRef: 'iss5' });
    const failing = async () => {
      throw new Error('discord down');
    };
    await expect(escalateUnclaimed(db, { now: NOW, webhookUrl: 'x', send: failing })).rejects.toThrow('discord down');
    expect(db.select().from(schema.incidents).where(eq(schema.incidents.id, id)).get()!.escalationAlertedAt).toBeNull();
  });
});
