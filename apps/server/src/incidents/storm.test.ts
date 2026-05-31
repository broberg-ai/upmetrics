// F008.3 fleet-scale alert-storm control — proves the three ACs against an
// in-memory DB (no network). Run: bun test src/incidents/storm.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDb, schema, type Db } from '../db';
import { config } from '../config';
import { planStorm, runAlertsStorm, buildRollupMessage, _resetStormState } from './storm';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;

let seq = 0;
function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string): void {
  db.insert(schema.projects)
    .values({
      id,
      name: id,
      dsn: `https://key_${id}@upmetrics.org/${id}`,
      apiKey: `uk_${id}`,
      platform: 'web',
      retentionDays: 30,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
}
function addIncident(db: Db, projectId: string, kind = 'probe_down', severity = 'high'): string {
  const id = `inc_${++seq}`;
  db.insert(schema.incidents)
    .values({
      id,
      projectId,
      kind,
      status: 'open',
      severity,
      title: `${kind} on ${projectId}`,
      openedAt: new Date(),
      triggerRef: `ref_${id}`,
    })
    .run();
  return id;
}
function addRule(db: Db, projectId: string, kind = '*', channels: string[] = ['email']): void {
  db.insert(schema.alertRules)
    .values({ id: `rule_${++seq}`, projectId, kind, condition: null, channels, enabled: true, createdAt: new Date() })
    .run();
}
function addWindow(db: Db, opts: { projectId?: string | null; kind?: string | null; reason?: string }): void {
  const now = Date.now();
  db.insert(schema.maintenanceWindows)
    .values({
      id: `mw_${++seq}`,
      reason: opts.reason ?? 'planned',
      projectId: opts.projectId ?? null,
      kind: opts.kind ?? null,
      startsAt: new Date(now - 1000),
      endsAt: new Date(now + 3_600_000),
      createdAt: new Date(),
    })
    .run();
}

beforeEach(() => _resetStormState());

describe('F008.3 storm-control', () => {
  it('AC1: N incidents across projects collapse into ONE roll-up with a count (not N)', async () => {
    const db = freshDb();
    for (const p of ['a', 'b', 'c']) {
      addProject(db, p);
      addIncident(db, p);
      addRule(db, p); // would each alert individually without storm-control
    }
    const plan = planStorm(db);
    expect(plan.mode).toBe('fleet');
    expect(plan.projectCount).toBe(3);
    expect(plan.openCount).toBe(3);
    expect(buildRollupMessage(plan)).toContain('3 incidents across 3 projects');

    const res = await runAlertsStorm(db);
    expect(res.rollupSent).toBe(true); // exactly one roll-up
    expect(res.fired).toBe(0); // zero per-site messages
    expect(res.suppressed).toBe(3); // all folded into the roll-up
  });

  it('AC2: a region/upmetrics-down signal suppresses downstream per-site alerts', async () => {
    const db = freshDb();
    addProject(db, 'upmetrics');
    addProject(db, 'siteX');
    addIncident(db, 'upmetrics', 'region_down', 'critical'); // suppressor signal
    addIncident(db, 'siteX', 'probe_down'); // downstream noise
    addRule(db, 'siteX');

    const plan = planStorm(db);
    // Only 2 projects / 2 incidents (below thresholds) — fleet purely via the signal.
    expect(plan.mode).toBe('fleet');
    expect(plan.suppressorKinds).toContain('region_down');

    const res = await runAlertsStorm(db);
    expect(res.fired).toBe(0);
    expect(res.suppressed).toBe(2);
    expect(res.rollupSent).toBe(true);
  });

  it('AC3a: a maintenance window silences matching alerts (others still fire)', async () => {
    const db = freshDb();
    addProject(db, 'siteY');
    addIncident(db, 'siteY', 'probe_down');
    addRule(db, 'siteY');
    addWindow(db, { projectId: 'siteY', reason: 'db upgrade' });

    const res = await runAlertsStorm(db);
    expect(res.suppressed).toBe(1); // silenced by the window
    expect(res.fired).toBe(0);

    // Without a window the same incident fires (delivery attempted, no network).
    _resetStormState();
    const db2 = freshDb();
    addProject(db2, 'siteY');
    addIncident(db2, 'siteY', 'probe_down');
    addRule(db2, 'siteY');
    const res2 = await runAlertsStorm(db2);
    expect(res2.fired).toBe(1);
    expect(res2.suppressed).toBe(0);
  });

  it('AC3b: global rate-limit diverts overflow into a single digest', async () => {
    const db = freshDb();
    addProject(db, 'solo');
    addIncident(db, 'solo', 'probe_down'); // 1 incident → stays non-fleet
    const cap = config.alertRateCapacity;
    const extra = 2;
    for (let i = 0; i < cap + extra; i++) addRule(db, 'solo'); // each rule = one would-be send

    const plan = planStorm(db);
    expect(plan.mode).toBe('normal'); // not a fleet outage — the rate-limit path

    const res = await runAlertsStorm(db);
    expect(res.fired).toBe(cap); // bucket capacity sent
    expect(res.digested).toBe(extra); // overflow diverted
    expect(res.digestSent).toBe(extra); // collapsed into one digest
  });
});
