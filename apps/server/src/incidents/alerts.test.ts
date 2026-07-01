// Alert engine (F005.2) dedup window — proves credit_low gets a longer,
// once/day window instead of the default hourly re-alert. Run: bun test src/incidents/alerts.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { createDb, schema, type Db } from '../db';
import { runAlerts } from './alerts';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const origFetch = globalThis.fetch;

let seq = 0;
function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string): void {
  db.insert(schema.projects)
    .values({ id, name: id, dsn: `https://k@upmetrics.org/${id}`, apiKey: `uk_${id}`, platform: 'web', retentionDays: 30, createdAt: new Date(), updatedAt: new Date() })
    .run();
}
function addIncident(db: Db, projectId: string, kind: string): string {
  const id = `inc_${++seq}`;
  db.insert(schema.incidents)
    .values({ id, projectId, kind, status: 'open', severity: 'high', title: `${kind} on ${projectId}`, openedAt: new Date(), triggerRef: `ref_${id}` })
    .run();
  return id;
}
function addRule(db: Db, projectId: string, kind: string): void {
  db.insert(schema.alertRules)
    .values({ id: `rule_${++seq}`, projectId, kind, condition: null, channels: ['discord'], enabled: true, createdAt: new Date() })
    .run();
}

beforeEach(() => {
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('credit_low alert dedup window (once/day, no hourly nagging)', () => {
  it('an unchanged credit_low incident is NOT re-alerted 2h later (still within the 24h window)', async () => {
    const db = freshDb();
    addProject(db, 'p1');
    addIncident(db, 'p1', 'credit_low');
    addRule(db, 'p1', 'credit_low');
    const t0 = new Date(0);
    const first = await runAlerts(db, t0);
    expect(first.fired).toBe(1);
    const t1 = new Date(2 * 3_600_000); // +2h
    const second = await runAlerts(db, t1);
    expect(second.fired).toBe(0);
    expect(second.deduped).toBe(1);
  });

  it('a probe_down incident (default 1h window) DOES re-alert 2h later — other kinds unaffected', async () => {
    const db = freshDb();
    addProject(db, 'p2');
    addIncident(db, 'p2', 'probe_down');
    addRule(db, 'p2', 'probe_down');
    const t0 = new Date(0);
    const first = await runAlerts(db, t0);
    expect(first.fired).toBe(1);
    const t1 = new Date(2 * 3_600_000); // +2h, past the default 1h window
    const second = await runAlerts(db, t1);
    expect(second.fired).toBe(1);
    expect(second.deduped).toBe(0);
  });
});
