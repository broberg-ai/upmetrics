// F007.1 retention + compaction. Run: bun test src/ops/retention.test.ts
import { describe, it, expect } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq, sql } from 'drizzle-orm';
import { createDb, schema, type Db } from '../db';
import { config } from '../config';
import { runRetention } from './retention';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const DAY = 86_400_000;
const NOW = new Date('2026-05-31T12:00:00Z');
let seq = 0;

function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string, opts: Partial<typeof schema.projects.$inferInsert> = {}): void {
  db.insert(schema.projects)
    .values({
      id,
      name: id,
      dsn: `https://k_${id}@upmetrics.org/${id}`,
      apiKey: `uk_${id}`,
      platform: 'web',
      retentionDays: 30,
      agentRetentionDays: 90,
      createdAt: NOW,
      updatedAt: NOW,
      ...opts,
    })
    .run();
}
function addEvent(db: Db, projectId: string, ageDays: number): void {
  const ts = new Date(NOW.getTime() - ageDays * DAY);
  db.insert(schema.events)
    .values({ id: `ev_${++seq}`, projectId, kind: 'error', receivedAt: ts, occurredAt: ts, payload: {} })
    .run();
}
function addAgentRun(db: Db, projectId: string, ageDays: number): void {
  const ts = new Date(NOW.getTime() - ageDays * DAY);
  db.insert(schema.agentRuns)
    .values({
      id: `ar_${++seq}`,
      projectId,
      sessionId: `s_${seq}`,
      agentKind: 'cc',
      agentName: 'tester',
      task: 't',
      provider: 'anthropic',
      model: 'opus',
      status: 'success',
      startedAt: ts,
    })
    .run();
}
function addProbe(db: Db, id: string, projectId: string): void {
  db.insert(schema.probes)
    .values({ id, projectId, name: id, kind: 'http', target: 'https://x', intervalSeconds: 300 })
    .run();
}
function addProbeResult(db: Db, probeId: string, ageDays: number, atHourMinute = 0, ok = true, ms = 100): void {
  const ts = new Date(NOW.getTime() - ageDays * DAY + atHourMinute * 60_000);
  db.insert(schema.probeResults)
    .values({ id: `pr_${++seq}`, probeId, checkedAt: ts, ok, responseMs: ms })
    .run();
}
const countEvents = (db: Db, p: string) =>
  db.select({ c: sql<number>`count(*)` }).from(schema.events).where(eq(schema.events.projectId, p)).get()!.c;

describe('F007.1 retention', () => {
  it('AC0: deletes events older than retention_days, keeps newer', () => {
    const db = freshDb();
    addProject(db, 'a', { retentionDays: 30 });
    addEvent(db, 'a', 10); // keep
    addEvent(db, 'a', 45); // purge
    addEvent(db, 'a', 60); // purge
    const r = runRetention(db, NOW);
    expect(r.eventsDeleted).toBe(2);
    expect(countEvents(db, 'a')).toBe(1);
  });

  it('AC1a: agent_runs use the independent (longer) agent_retention_days', () => {
    const db = freshDb();
    addProject(db, 'a', { retentionDays: 30, agentRetentionDays: 90 });
    addEvent(db, 'a', 60); // event @60d, retention 30 → purged
    addAgentRun(db, 'a', 60); // run @60d, agent retention 90 → KEPT
    addAgentRun(db, 'a', 120); // run @120d → purged
    const r = runRetention(db, NOW);
    expect(r.eventsDeleted).toBe(1);
    expect(r.agentRunsDeleted).toBe(1);
    expect(db.select().from(schema.agentRuns).all().length).toBe(1);
  });

  it('AC1b: probe_results older than 7d downsample to one hourly row (sample_count=N)', () => {
    const db = freshDb();
    addProject(db, 'a');
    addProbe(db, 'p1', 'a');
    // 4 raw checks in the SAME hour, 10 days old → collapse to 1
    addProbeResult(db, 'p1', 10, 0, true, 100);
    addProbeResult(db, 'p1', 10, 5, true, 200);
    addProbeResult(db, 'p1', 10, 10, false, 300);
    addProbeResult(db, 'p1', 10, 15, true, 400);
    // 1 recent check (2 days old) → untouched
    addProbeResult(db, 'p1', 2, 0, true, 50);
    const r = runRetention(db, NOW);
    expect(r.probeResultsCompacted).toBe(3); // 4 → 1, so 3 removed
    const rows = db.select().from(schema.probeResults).all();
    expect(rows.length).toBe(2); // 1 aggregate + 1 recent
    const agg = rows.find((x) => x.sampleCount === 4)!;
    expect(agg).toBeTruthy();
    expect(agg.responseMs).toBe(250); // avg(100,200,300,400)
    expect(agg.ok).toBe(true); // 3/4 ok → majority
  });

  it('AC2: batched deletes drain a backlog larger than one batch', () => {
    const db = freshDb();
    addProject(db, 'a', { retentionDays: 1 });
    const n = config.retentionBatchSize + 100; // > one batch
    for (let i = 0; i < n; i++) addEvent(db, 'a', 5); // all expired
    const r = runRetention(db, NOW);
    expect(r.eventsDeleted).toBe(n);
    expect(countEvents(db, 'a')).toBe(0);
  });
});
