// F022.2 credit-snapshot ingest. Run: bun test src/credits/routes.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb } from '../db';
import { config } from '../config';
import { registerCreditRoutes } from './routes';
import { latestSnapshot } from './store';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const TOKEN = 'credit_test_token';
const app = new Hono();

beforeAll(() => {
  // config reads env at import (before this file's top-level runs); set the token here.
  (config as { creditIngestToken: string }).creditIngestToken = TOKEN;
  migrate(getDb(), { migrationsFolder: MIGRATIONS });
  registerCreditRoutes(app);
});

const post = (provider: string, body: unknown, token: string | null = TOKEN) =>
  app.request(`/api/providers/${provider}/credit-snapshot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-upmetrics-credit-key': token } : {}) },
    body: JSON.stringify(body),
  });
const json = (r: Response) => r.json() as Promise<any>;

describe('POST /api/providers/:provider/credit-snapshot', () => {
  it('401 without a valid ingest token', async () => {
    expect((await post('ing_or', { total_credits: 50, total_usage: 10 }, null)).status).toBe(401);
    expect((await post('ing_or', { total_credits: 50, total_usage: 10 }, 'wrong')).status).toBe(401);
  });

  it('valid POST persists a snapshot; latest reflects it; remaining computed', async () => {
    const r = await post('ing_or', { total_credits: 50, total_usage: 12.5, raw: { data: { total_credits: 50, total_usage: 12.5 } } });
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.ok).toBe(true);
    expect(b.remaining).toBeCloseTo(37.5, 6);
    const latest = latestSnapshot(getDb(), 'ing_or');
    expect(latest?.id).toBe(b.id);
    expect(latest?.remaining).toBeCloseTo(37.5, 6);
  });

  it('400 on malformed payload (non-numeric)', async () => {
    expect((await post('ing_or', { total_credits: 'lots', total_usage: 1 })).status).toBe(400);
    expect((await post('ing_or', {})).status).toBe(400);
  });

  it('400 on a negative-balance payload (usage > credits, or negative inputs)', async () => {
    expect((await post('ing_or', { total_credits: 5, total_usage: 9 })).status).toBe(400);
    expect((await post('ing_or', { total_credits: -1, total_usage: 0 })).status).toBe(400);
  });
});
