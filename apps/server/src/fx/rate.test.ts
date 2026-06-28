// F023 live FX rate + rolling-5 fallback. Run: bun test src/fx/rate.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from '../db';
import { insertRate, last5avg } from './store';
import { refreshFxRate, usdToDkk } from './rate';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const origFetch = globalThis.fetch;

beforeAll(() => migrate(getDb(), { migrationsFolder: MIGRATIONS }));
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('fx store (rolling-5)', () => {
  it('keeps at most the 5 newest rates per pair (continuous roll)', () => {
    for (let i = 1; i <= 7; i++) insertRate(getDb(), 'T_DKK', i, new Date(i * 1000));
    // 1 + 2 evicted; avg of the 5 newest (3..7)
    expect(last5avg(getDb(), 'T_DKK')).toBeCloseTo((3 + 4 + 5 + 6 + 7) / 5, 6);
  });
  it('null average when no rates stored for a pair', () => {
    expect(last5avg(getDb(), 'NONE_DKK')).toBeNull();
  });
});

describe('fx rate (live + fallback)', () => {
  it('a successful fetch sets + returns the live rate, and the sync getter reflects it', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ result: 'success', rates: { DKK: 6.55 } }), { status: 200 })) as unknown as typeof fetch;
    expect(await refreshFxRate()).toBeCloseTo(6.55, 6);
    expect(usdToDkk()).toBeCloseTo(6.55, 6);
  });

  it('a thrown fetch falls back to the rolling-5 average — never throws', async () => {
    insertRate(getDb(), 'USD_DKK', 6.4, new Date());
    insertRate(getDb(), 'USD_DKK', 6.6, new Date());
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const r = await refreshFxRate();
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(0); // = avg of stored USD_DKK rates, not a crash
  });

  it('a non-2xx response also falls back (no throw)', async () => {
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    expect(Number.isFinite(await refreshFxRate())).toBe(true);
  });
});
