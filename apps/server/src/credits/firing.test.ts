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

// ── F022.5 — the alarm's own number must not go stale ────────────────────────
describe('an open credit_low keeps its title current', () => {
  it('rewrites the balance in the title as it falls', () => {
    // Measured on prod 2026-09-04: an incident opened 30 August still read
    // "$9.66 remaining" while the live balance was $7.41. Christian read that
    // title and made a decision from a five-day-old number. On a balance alarm
    // the number IS the alarm, so a title written once at open is not a
    // cosmetic flaw — it is the alarm reporting something that is no longer true.
    const db = getDb();
    evalCreditAlarm(db, PROJ, snap(9.66, 10_000));
    const first = openCreditLow()!;
    expect(first.title).toContain('$9.66');

    evalCreditAlarm(db, PROJ, snap(7.41, 20_000));
    const later = openCreditLow()!;
    expect(later.id).toBe(first.id); // the SAME incident, not a second one
    expect(later.title).toContain('$7.41');
    expect(later.title).not.toContain('$9.66');
  });

  it('still resolves when the balance recovers — the update did not break the exit', () => {
    // The negative control: a rewrite path that never lets go would keep an
    // alarm alive forever, which is worse than a stale title.
    const db = getDb();
    evalCreditAlarm(db, PROJ, snap(5, 30_000));
    expect(openCreditLow()).toBeTruthy();
    evalCreditAlarm(db, PROJ, snap(50, 40_000));
    expect(openCreditLow()).toBeUndefined();
  });
});
