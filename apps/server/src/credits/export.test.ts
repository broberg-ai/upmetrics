// F022.5 export-API (read-only, scoped Bearer). Run: bun test src/credits/export.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { config } from '../config';
import { registerCreditRoutes } from './routes';
import { insertSnapshot } from './store';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const READ = 'export_read_token';
const PROV = 'exp_or';
const app = new Hono();

beforeAll(() => {
  (config as { exportReadToken: string }).exportReadToken = READ;
  (config as { creditIngestToken: string }).creditIngestToken = 'exp_ingest';
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  registerCreditRoutes(app);

  const DAY = 86_400_000;
  insertSnapshot(db, { provider: PROV, totalCredits: 50, totalUsage: 30, capturedAt: new Date(DAY * 1) });
  insertSnapshot(db, { provider: PROV, totalCredits: 50, totalUsage: 35, capturedAt: new Date(DAY * 2) }); // remaining 15, +$5/day

  // agent_runs for the breakdown endpoint (provider-filtered).
  db.insert(schema.projects)
    .values({ id: 'exp_proj', name: 'Exp', dsn: 'https://k@upmetrics.org/exp', apiKey: 'uk_exp', platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: new Date(), updatedAt: new Date() })
    .run();
  const run = (o: Partial<typeof schema.agentRuns.$inferInsert>) =>
    db.insert(schema.agentRuns).values({
      id: crypto.randomUUID(), projectId: 'exp_proj', agentKind: 'chatbot', agentName: 'x', task: '',
      provider: 'openrouter', model: 'gpt-4o', status: 'success', startedAt: new Date(DAY * 2),
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, ...o,
    }).run();
  run({ model: 'gpt-4o', costUsd: 0.01 });
  run({ model: 'claude-sonnet-4-6', costUsd: 0.02 });
});

const get = (path: string, token: string | null = READ) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const json = (r: Response) => r.json() as Promise<any>;

describe('export-API auth (scoped read-only Bearer)', () => {
  it('401 without / with a wrong Bearer', async () => {
    expect((await get(`/api/v1/providers/${PROV}/balance`, null)).status).toBe(401);
    expect((await get(`/api/v1/providers/${PROV}/balance`, 'nope')).status).toBe(401);
  });

  it('a read token cannot WRITE (credit-snapshot ingest rejects the Bearer)', async () => {
    const r = await app.request(`/api/providers/${PROV}/credit-snapshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${READ}` },
      body: JSON.stringify({ total_credits: 9, total_usage: 1 }),
    });
    expect(r.status).toBe(401); // ingest needs x-upmetrics-credit-key, not the read Bearer
  });
});

describe('export-API reads', () => {
  it('/balance returns latest + DKK companion + alarm badge', async () => {
    const b = await json(await get(`/api/v1/providers/${PROV}/balance`));
    expect(b.has_data).toBe(true);
    expect(b.remaining_usd).toBeCloseTo(15, 6);
    expect(b.remaining_dkk).toBeCloseTo(Math.round(15 * config.usdToDkk * 100) / 100, 6);
    expect(b.alarm).toBe('ok'); // 15 > warn 10
  });

  it('/balance for an unknown provider → 200 has_data:false (ship-dark wiring)', async () => {
    const b = await json(await get('/api/v1/providers/never_seen/balance'));
    expect(b.has_data).toBe(false);
  });

  it('/alarms computes the band state', async () => {
    const b = await json(await get(`/api/v1/providers/${PROV}/alarms`));
    expect(b.state).toBe('ok');
    expect(b.thresholds.warn_below).toBe(config.creditWarnBelowUsd);
  });

  it('/burn-rate derives spend/day + days-left from two snapshots', async () => {
    const b = await json(await get(`/api/v1/providers/${PROV}/burn-rate`));
    expect(b.per_day_usd).toBeCloseTo(5, 6); // +$5/day
    expect(b.days_left).toBeCloseTo(3, 1); // remaining 15 / 5
    expect(b.based_on_snapshots).toBe(2);
  });

  it('/usage/breakdown groups agent_runs by model in micro_usd', async () => {
    const b = await json(await get('/api/v1/usage/breakdown?provider=openrouter&group_by=model&from=0'));
    expect(b.group_by).toBe('model');
    const byModel = Object.fromEntries(b.by_group.map((x: any) => [x.key, x.micro_usd]));
    expect(byModel['gpt-4o']).toBe(10000); // 0.01 * 1e6
    expect(byModel['claude-sonnet-4-6']).toBe(20000);
  });

  it('/history returns ascending points within the window', async () => {
    const b = await json(await get(`/api/v1/providers/${PROV}/balance/history?from=0`));
    expect(b.points.length).toBe(2);
    expect(new Date(b.points[0].captured_at).getTime()).toBeLessThan(new Date(b.points[1].captured_at).getTime());
  });
});
