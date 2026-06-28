// F022.1 credit_snapshots store. Run: bun test src/credits/store.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from '../db';
import { insertSnapshot, latestSnapshot, recentSnapshots } from './store';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
// Namespaced providers — getDb() is a shared singleton across sibling test files.
const OR = 'cs_openrouter';
const FAL = 'cs_falai';

beforeAll(() => {
  migrate(getDb(), { migrationsFolder: MIGRATIONS });
});

describe('credit_snapshots store', () => {
  it('stores remaining = total_credits − total_usage', () => {
    const snap = insertSnapshot(getDb(), { provider: OR, totalCredits: 50, totalUsage: 12.34, capturedAt: new Date(1_000) });
    expect(snap.remaining).toBeCloseTo(37.66, 6);
  });

  it('latestSnapshot returns the most recent by captured_at', () => {
    insertSnapshot(getDb(), { provider: OR, totalCredits: 50, totalUsage: 20, capturedAt: new Date(2_000) });
    insertSnapshot(getDb(), { provider: OR, totalCredits: 50, totalUsage: 25, capturedAt: new Date(3_000) }); // newest
    const latest = latestSnapshot(getDb(), OR);
    expect(latest?.totalUsage).toBe(25);
    expect(latest?.remaining).toBe(25);
  });

  it('is multi-provider — providers stay isolated', () => {
    insertSnapshot(getDb(), { provider: FAL, totalCredits: 100, totalUsage: 10, capturedAt: new Date(5_000) });
    expect(latestSnapshot(getDb(), FAL)?.remaining).toBe(90);
    expect(latestSnapshot(getDb(), OR)?.remaining).toBe(25); // unchanged by the FAL write
  });

  it('recentSnapshots returns the N newest in desc order (burn-rate input)', () => {
    const rows = recentSnapshots(getDb(), OR, 2);
    expect(rows.length).toBe(2);
    expect(rows[0]!.capturedAt.getTime()).toBeGreaterThan(rows[1]!.capturedAt.getTime());
  });

  it('latestSnapshot is null for an unknown provider (ship-dark state)', () => {
    expect(latestSnapshot(getDb(), 'cs_never_seen')).toBeNull();
  });
});
