// F022.4 firing — credit_low incident open/resolve. Run: bun test src/credits/firing.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { config } from '../config';
import { insertSnapshot } from './store';
import { evalCreditAlarm } from './alarms';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const PROJ = 'cf_self';
const PROV = 'fire_or';

function openCreditLow() {
  return getDb()
    .select()
    .from(schema.incidents)
    .where(and(eq(schema.incidents.triggerRef, `credit_low:${PROV}`), eq(schema.incidents.kind, 'credit_low'), eq(schema.incidents.status, 'open')))
    .get();
}
function snap(remaining: number, ms: number) {
  // totalUsage arbitrary; remaining is what the alarm reads.
  return insertSnapshot(getDb(), { provider: PROV, totalCredits: remaining + 5, totalUsage: 5, capturedAt: new Date(ms) });
}

beforeAll(() => {
  (config as { creditWarnBelowUsd: number }).creditWarnBelowUsd = 10;
  (config as { creditCriticalBelowUsd: number }).creditCriticalBelowUsd = 2;
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  db.insert(schema.projects)
    .values({ id: PROJ, name: 'Self', dsn: 'https://k@upmetrics.org/cf', apiKey: 'uk_cf', platform: 'node', retentionDays: 30, agentRetentionDays: 90, createdAt: new Date(), updatedAt: new Date() })
    .run();
});

describe('evalCreditAlarm', () => {
  it('healthy balance → no incident', () => {
    const s = evalCreditAlarm(getDb(), PROJ, snap(50, 1000));
    expect(s).toBe('ok');
    expect(openCreditLow()).toBeUndefined();
  });

  it('warn band → opens a credit_low incident at severity high', () => {
    evalCreditAlarm(getDb(), PROJ, snap(8, 2000)); // < warn 10
    const inc = openCreditLow();
    expect(inc?.severity).toBe('high');
    expect(inc?.kind).toBe('credit_low');
    // burn-rate travels with the alarm (AC: included in the alarm payload)
    expect(inc?.eventsAtOpen).toHaveProperty('burn_rate_per_day');
    expect(inc?.eventsAtOpen).toHaveProperty('days_left');
  });

  it('critical band → escalates the SAME incident to critical (no duplicate)', () => {
    evalCreditAlarm(getDb(), PROJ, snap(1, 3000)); // < critical 2
    const all = getDb()
      .select()
      .from(schema.incidents)
      .where(and(eq(schema.incidents.triggerRef, `credit_low:${PROV}`), eq(schema.incidents.status, 'open')))
      .all();
    expect(all.length).toBe(1); // escalated in place, not a second incident
    expect(all[0]!.severity).toBe('critical');
  });

  it('recovery → resolves the open incident', () => {
    const s = evalCreditAlarm(getDb(), PROJ, snap(40, 4000)); // back above warn
    expect(s).toBe('ok');
    expect(openCreditLow()).toBeUndefined();
  });
});
