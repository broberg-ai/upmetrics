// F014 cost read-API. Run: bun test src/cost/routes.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { registerCostRoutes } from './routes';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const KEY = 'uk_xrt';
const app = new Hono();

beforeAll(() => {
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  db.insert(schema.projects)
    .values({ id: 'xrt81', name: 'XRT81', dsn: 'https://k@upmetrics.org/xrt81', apiKey: KEY, platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: new Date(), updatedAt: new Date() })
    .run();
  // also a second project to prove scoping
  db.insert(schema.projects)
    .values({ id: 'other', name: 'Other', dsn: 'https://k@upmetrics.org/other', apiKey: 'uk_other', platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: new Date(), updatedAt: new Date() })
    .run();

  const now = new Date();
  const run = (o: Partial<typeof schema.agentRuns.$inferInsert>) =>
    db.insert(schema.agentRuns).values({
      id: crypto.randomUUID(), projectId: 'xrt81', agentKind: 'chatbot', agentName: 'xrt81', task: '',
      provider: 'anthropic', model: 'claude-sonnet-4-6', status: 'success', startedAt: now,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0,
      ...o,
    }).run();

  run({ provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'vision', inputTokens: 1000, outputTokens: 100, costUsd: 0.005, tags: { capability: 'vision', transport: 'http', sdk: '@broberg/ai-sdk@0.1.1' } });
  run({ provider: 'openai', model: 'gpt-4o', tier: 'smart', inputTokens: 500, outputTokens: 50, costUsd: 0.002, tags: { capability: 'chat', transport: 'http' } });
  run({ provider: 'anthropic', model: 'claude-sonnet-4-6', tier: 'smart', inputTokens: 200, outputTokens: 20, costUsd: 0, tags: { capability: 'chat', transport: 'subprocess' } }); // free (Max)
  // a run on the OTHER project — must never appear in xrt81's totals
  run({ projectId: 'other', costUsd: 9.99, tags: { capability: 'chat', transport: 'http' } });

  registerCostRoutes(app);
});

function get(path: string, key: string | null = KEY) {
  return app.request(path, { headers: key ? { 'x-upmetrics-key': key } : {} });
}
const json = (r: Response) => r.json() as Promise<any>;

describe('GET /api/cost/summary', () => {
  it('401 without a valid key', async () => {
    expect((await get('/api/cost/summary', null)).status).toBe(401);
  });

  it('totals in integer micro-USD, project-scoped, metered split', async () => {
    const r = await get('/api/cost/summary');
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.run_count).toBe(3); // excludes the other-project row
    expect(b.total_micro_usd).toBe(7000); // (0.005+0.002+0)*1e6
    expect(b.input_tokens).toBe(1700);
    expect(b.output_tokens).toBe(170);
    expect(b.metered.metered_micro_usd).toBe(7000); // subprocess/$0 run excluded
    expect(b.metered.free_run_count).toBe(1);
    expect(b.generated_at).toBeTruthy();
  });

  it('breakdowns by provider/model/tier/capability', async () => {
    const b = await json(await get('/api/cost/summary'));
    const prov = Object.fromEntries(b.by_provider.map((x: any) => [x.key, x.micro_usd]));
    expect(prov.anthropic).toBe(5000); // 0.005 + 0 free
    expect(prov.openai).toBe(2000);
    const cap = Object.fromEntries(b.by_capability.map((x: any) => [x.key, x.micro_usd]));
    expect(cap.vision).toBe(5000);
    expect(cap.chat).toBe(2000);
  });

  it('filters: transport=http excludes subprocess; provider filter scopes', async () => {
    const http = await json(await get('/api/cost/summary?transport=http'));
    expect(http.run_count).toBe(2);
    expect(http.total_micro_usd).toBe(7000);
    const oai = await json(await get('/api/cost/summary?provider=openai'));
    expect(oai.run_count).toBe(1);
    expect(oai.total_micro_usd).toBe(2000);
  });
});

describe('GET /api/cost/timeseries', () => {
  it('non-zero buckets with micro-USD + tokens', async () => {
    const b = await json(await get('/api/cost/timeseries?bucket=day'));
    expect(b.bucket).toBe('day');
    expect(b.points.length).toBe(1); // all seeded today → one day bucket
    expect(b.points[0].micro_usd).toBe(7000);
    expect(b.points[0].run_count).toBe(3);
  });
});
