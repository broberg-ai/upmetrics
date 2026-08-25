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

// F025.2 — the ceiling time-based retention cannot provide.
// The 2026-07-30 outage was NOT missing retention: the 30-day window held the
// whole time. What it failed to bound was SIZE — one project flooded 163k
// events (552 MB) INSIDE its window and became 96% of the database, leaving
// every other project's history a rounding error. These fail if that ceiling
// stops being enforced.
describe('F025.2 per-project event cap', () => {
  it('prunes a flooder to the cap even though every event is inside the retention window', () => {
    const db = freshDb();
    addProject(db, 'flooder', { retentionDays: 30 });
    for (let i = 0; i < 25; i++) addEvent(db, 'flooder', 1); // 1 day old — none expired

    const r = runRetention(db, NOW, { maxEventsPerProject: 10 });

    expect(r.eventsDeleted).toBe(0); // nothing aged out → proves the CAP did it
    expect(r.eventsCapped).toBe(15);
    expect(countEvents(db, 'flooder')).toBe(10);
  });

  it('drops the OLDEST first, so the most recent history survives a flood', () => {
    const db = freshDb();
    addProject(db, 'flooder');
    addEvent(db, 'flooder', 9); // oldest
    addEvent(db, 'flooder', 8);
    addEvent(db, 'flooder', 1); // newest
    const oldest = db.select().from(schema.events).all()[0]!.id;

    runRetention(db, NOW, { maxEventsPerProject: 2 });

    const left = db.select().from(schema.events).all();
    expect(left.length).toBe(2);
    expect(left.some((e) => e.id === oldest)).toBe(false); // the oldest is the one gone
  });

  it('does not let one project’s flood evict another project’s history', () => {
    const db = freshDb();
    addProject(db, 'flooder');
    addProject(db, 'victim');
    for (let i = 0; i < 20; i++) addEvent(db, 'flooder', 1);
    for (let i = 0; i < 5; i++) addEvent(db, 'victim', 1);

    runRetention(db, NOW, { maxEventsPerProject: 10 });

    expect(countEvents(db, 'victim')).toBe(5); // untouched — this is the whole point
    expect(countEvents(db, 'flooder')).toBe(10);
  });

  it('leaves a well-behaved project completely alone', () => {
    const db = freshDb();
    addProject(db, 'quiet');
    for (let i = 0; i < 5; i++) addEvent(db, 'quiet', 1);

    const r = runRetention(db, NOW, { maxEventsPerProject: 10 });

    expect(r.eventsCapped).toBe(0);
    expect(countEvents(db, 'quiet')).toBe(5);
  });

  it('bounds work per tick so a huge backlog cannot freeze the event loop in one pass', () => {
    // bun:sqlite is synchronous: an unbounded one-shot prune blocks every
    // request, which is the 2026-06-02 stall class. A backlog must drain over
    // several ticks instead of freezing the server once.
    const db = freshDb();
    addProject(db, 'flooder');
    const budget = config.retentionCapBudgetPerTick;
    expect(budget).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) addEvent(db, 'flooder', 1);

    const r = runRetention(db, NOW, { maxEventsPerProject: 5 });

    expect(r.eventsCapped).toBeLessThanOrEqual(budget);
    expect(r.eventsCapped).toBe(25); // budget (20k) far exceeds this backlog
  });

  it('cap of 0 disables the ceiling (escape hatch, no accidental deletion)', () => {
    const db = freshDb();
    addProject(db, 'x');
    for (let i = 0; i < 8; i++) addEvent(db, 'x', 1);

    const r = runRetention(db, NOW, { maxEventsPerProject: 0 });

    expect(r.eventsCapped).toBe(0);
    expect(countEvents(db, 'x')).toBe(8);
  });
});

// F025.2 — "deleted 0 because there was nothing" vs "deleted 0 because deleting
// stopped working". Both are silence; only one fills the disk. The blocked
// delete below is a REAL silent failure against a real database (a BEFORE
// DELETE trigger that raises IGNORE drops the row operation without an error),
// not a stub — the point is to reproduce the exact shape the old code reported
// as success: it counted the rows it SELECTED, so a delete that removed nothing
// still logged a confident number.
function blockDeletes(db: Db, table: 'events' | 'probe_results'): void {
  db.run(sql.raw(`CREATE TRIGGER block_${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(IGNORE); END;`));
}

describe('F025.2 a prune that removes nothing must not report success', () => {
  it('reports 0 deleted — not the number it selected — when the delete silently does nothing', () => {
    const db = freshDb();
    addProject(db, 'a', { retentionDays: 30 });
    for (let i = 0; i < 3; i++) addEvent(db, 'a', 60); // all expired
    blockDeletes(db, 'events');

    const r = runRetention(db, NOW);

    expect(r.eventsDeleted).toBe(0); // the old code reported 3 here
    expect(countEvents(db, 'a')).toBe(3); // and the rows really are still there
    expect(r.anomalies.length).toBeGreaterThan(0);
    expect(r.anomalies[0]).toContain('valgte 3');
  });

  it('says nothing when the prune genuinely worked — the negative control', () => {
    const db = freshDb();
    addProject(db, 'a', { retentionDays: 30 });
    for (let i = 0; i < 3; i++) addEvent(db, 'a', 60);

    const r = runRetention(db, NOW);

    expect(r.eventsDeleted).toBe(3);
    expect(r.anomalies).toEqual([]); // proves an empty list is a measurement, not the default
  });

  it('an empty database is silent — "nothing to do" never raises an anomaly', () => {
    const db = freshDb();
    addProject(db, 'a');

    const r = runRetention(db, NOW);

    expect(r.eventsDeleted).toBe(0);
    expect(r.anomalies).toEqual([]);
  });

  it('stops instead of re-selecting rows the delete refuses to remove', () => {
    // Without this guard the batch loop re-selects the same rows forever. On a
    // synchronous driver that is not a slow job, it is a frozen server — so a
    // regression here shows up as this test timing out, which is the intended
    // signal.
    const db = freshDb();
    addProject(db, 'a', { retentionDays: 1 });
    for (let i = 0; i < config.retentionBatchSize + 100; i++) addEvent(db, 'a', 5);
    blockDeletes(db, 'events');

    const r = runRetention(db, NOW);

    expect(r.eventsDeleted).toBe(0);
    expect(r.anomalies.length).toBeGreaterThan(0);
  });

  it('the per-project cap reports the same way when its delete is blocked', () => {
    const db = freshDb();
    addProject(db, 'flooder', { retentionDays: 30 });
    for (let i = 0; i < 25; i++) addEvent(db, 'flooder', 1); // inside the window
    blockDeletes(db, 'events');

    const r = runRetention(db, NOW, { maxEventsPerProject: 10 });

    expect(r.eventsCapped).toBe(0);
    expect(countEvents(db, 'flooder')).toBe(25);
    expect(r.anomalies.some((a) => a.includes('loft'))).toBe(true);
  });

  it('probe compaction does not drop the samples when the aggregate row fails to update', () => {
    const db = freshDb();
    addProject(db, 'a');
    addProbe(db, 'p1', 'a');
    for (let i = 0; i < 4; i++) addProbeResult(db, 'p1', 10, i * 5, true, 100);
    blockDeletes(db, 'probe_results');

    const r = runRetention(db, NOW);

    expect(r.probeResultsCompacted).toBe(0);
    expect(db.select().from(schema.probeResults).all().length).toBe(4); // nothing lost
    expect(r.anomalies.some((a) => a.includes('probe_results'))).toBe(true);
  });
});
