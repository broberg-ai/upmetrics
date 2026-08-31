import { describe, it, expect } from 'bun:test';
import { computeVerdict, type RegressionCfg } from './regression';

// 15m after-window, 60m baseline, 3× rate multiplier, floor of 3 after-errors.
const CFG: RegressionCfg = { windowMs: 900_000, baselineMs: 3_600_000, multiplier: 3, minAfter: 3 };
const verdict = (afterCount: number, baselineCount: number, newIssues: number) =>
  computeVerdict({ afterCount, baselineCount, newIssues }, CFG).verdict;

describe('computeVerdict', () => {
  it('healthy when the after-rate tracks the baseline', () => {
    // 2 errors in 15m vs 8 in 60m → same rate → not a regression.
    expect(verdict(2, 8, 0)).toBe('healthy');
  });

  it('regressed on an error-rate spike past the multiplier', () => {
    expect(verdict(20, 5, 0)).toBe('regressed');
  });

  it('regressed when a brand-new issue appears, even with few errors', () => {
    expect(verdict(1, 0, 1)).toBe('regressed');
  });

  it('healthy below the noise floor (2 after-errors on a clean baseline, < minAfter)', () => {
    expect(verdict(2, 0, 0)).toBe('healthy');
  });

  it('regressed when errors appear on a previously-clean surface (baseline 0, ≥ floor)', () => {
    expect(verdict(5, 0, 0)).toBe('regressed');
  });

  it('rate-normalised: a high raw count is healthy if the rate matches baseline', () => {
    // 10 in 15m vs 40 in 60m → identical rate → healthy despite 10 > floor.
    expect(verdict(10, 40, 0)).toBe('healthy');
  });

  it('detail carries the numbers + a reason', () => {
    const r = computeVerdict({ afterCount: 20, baselineCount: 5, newIssues: 0 }, CFG);
    expect(r.detail.after).toBe(20);
    expect(r.detail.baseline).toBe(5);
    expect(r.detail.reason).toContain('spike');
  });
});

// F026.1 — an alarm must not outlive the release it is about.
//
// Measured cost of not having this: "webhouse.app deploy regressed (f6063b7)"
// opened 26 Aug and fired every hour for five days — 124 alerts about a release
// replaced within the hour. 23 of the 24 alerts Christian received in the last
// day came from that single dead incident.
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, schema as sch, type Db as TDb } from '../db';
import { resolveSupersededRegressions } from './regression';

const MIGR = new URL('../db/migrations', import.meta.url).pathname;
const T0 = new Date('2026-08-26T12:00:00Z');
let n = 0;

function db2(): TDb {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGR });
  db.insert(sch.projects)
    .values({ id: 'p', name: 'p', dsn: 'd', apiKey: 'k', platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: T0, updatedAt: T0 })
    .run();
  return db;
}
function deploy(db: TDb, site: string, minutes: number) {
  const id = `dep_${++n}`;
  const at = new Date(T0.getTime() + minutes * 60_000);
  db.insert(sch.deployEvents)
    .values({ id, projectId: 'p', site, deployId: id, status: 'success', sha: `sha${n}`, createdAt: at, updatedAt: at })
    .run();
  return db.select().from(sch.deployEvents).where(eq(sch.deployEvents.id, id)).get()!;
}
function regression(db: TDb, triggerRef: string, site: string) {
  const id = `inc_${++n}`;
  db.insert(sch.incidents)
    .values({ id, projectId: 'p', kind: 'deploy_regression', status: 'open', severity: 'high', title: `${site} regressed`, openedAt: T0, triggerRef })
    .run();
  return id;
}
const statusOf = (db: TDb, id: string) => db.select().from(sch.incidents).where(eq(sch.incidents.id, id)).get()!.status;

describe('F026.1 a deploy_regression retires when a later deploy is measured healthy', () => {
  it('closes the alarm once a NEWER deploy of the same site came back clean', () => {
    const db = db2();
    const bad = deploy(db, 'webhouse.app', 0);
    const inc = regression(db, bad.id, 'webhouse.app');
    const good = deploy(db, 'webhouse.app', 60);

    expect(resolveSupersededRegressions(db, good)).toBe(1);
    expect(statusOf(db, inc)).toBe('resolved');
  });

  it('leaves it OPEN for a deploy of a DIFFERENT site', () => {
    // fysiodk ships web, ios and android under one project. A healthy web
    // deploy says nothing about the android build.
    const db = db2();
    const bad = deploy(db, 'fysiodk-android', 0);
    const inc = regression(db, bad.id, 'fysiodk-android');
    const good = deploy(db, 'fysiodk-web', 60);

    expect(resolveSupersededRegressions(db, good)).toBe(0);
    expect(statusOf(db, inc)).toBe('open');
  });

  it('leaves it OPEN when the healthy deploy is OLDER than the alarm’s own', () => {
    const db = db2();
    const bad = deploy(db, 'webhouse.app', 60);
    const inc = regression(db, bad.id, 'webhouse.app');
    const earlier = deploy(db, 'webhouse.app', 0);

    expect(resolveSupersededRegressions(db, earlier)).toBe(0);
    expect(statusOf(db, inc)).toBe('open');
  });

  it('a deploy does not resolve its OWN incident', () => {
    const db = db2();
    const d = deploy(db, 'webhouse.app', 0);
    const inc = regression(db, d.id, 'webhouse.app');

    expect(resolveSupersededRegressions(db, d)).toBe(0);
    expect(statusOf(db, inc)).toBe('open');
  });

  it('leaves it OPEN when the incident has no trigger, or points at a deploy we cannot read', () => {
    // We cannot prove such an alarm is superseded, so it stays. An alarm we
    // cannot reason about is not the same as one we have answered.
    const db = db2();
    const orphan = regression(db, 'dep_that_never_existed', 'webhouse.app');
    const good = deploy(db, 'webhouse.app', 60);

    expect(resolveSupersededRegressions(db, good)).toBe(0);
    expect(statusOf(db, orphan)).toBe('open');
  });

  it('touches nothing when there is no open alarm — the quiet case is quiet', () => {
    const db = db2();
    const good = deploy(db, 'webhouse.app', 60);
    expect(resolveSupersededRegressions(db, good)).toBe(0);
  });

  it('does not resolve an ALREADY-resolved alarm a second time', () => {
    const db = db2();
    const bad = deploy(db, 'webhouse.app', 0);
    const inc = regression(db, bad.id, 'webhouse.app');
    const good = deploy(db, 'webhouse.app', 60);

    expect(resolveSupersededRegressions(db, good)).toBe(1);
    expect(resolveSupersededRegressions(db, good)).toBe(0); // idempotent
    expect(statusOf(db, inc)).toBe('resolved');
  });
});
