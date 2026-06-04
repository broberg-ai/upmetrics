// F014 cost read-API. Run: bun test src/cost/routes.test.ts
process.env.DATABASE_PATH = ':memory:';
process.env.FLEET_READ_KEY = 'fleet_test_key'; // org read-token for /api/cost/fleet (read before config loads)

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { config } from '../config';
import { registerCostRoutes } from './routes';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const KEY = 'uk_xrt';
const MULTI_KEY = 'uk_multi';
const app = new Hono();

beforeAll(() => {
  // config reads env at import (before this file's top-level runs, ESM hoisting),
  // so set the org read-token here at runtime instead of via process.env.
  (config as { fleetReadKey: string }).fleetReadKey = 'fleet_test_key';
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

  // multi-tenant runs (ai-sdk labels → tags.tenantId) on their OWN project so
  // xrt81's exact totals above stay untouched. tenant filter + groupBy assert here.
  db.insert(schema.projects)
    .values({ id: 'multi', name: 'Multi', dsn: 'https://k@upmetrics.org/multi', apiKey: MULTI_KEY, platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: new Date(), updatedAt: new Date() })
    .run();
  run({ projectId: 'multi', costUsd: 0.01, tags: { capability: 'chat', transport: 'http', tenantId: 'sanne' } });
  run({ projectId: 'multi', costUsd: 0.02, tags: { capability: 'chat', transport: 'http', tenantId: 'sanne' } });
  run({ projectId: 'multi', costUsd: 0.04, tags: { capability: 'chat', transport: 'http', tenantId: 'bob' } });

  // Fleet runs on a separate project with DISTINCT agent_names — proves
  // /api/cost/fleet aggregates per-agent ACROSS projects (no project scope).
  db.insert(schema.projects)
    .values({ id: 'fleettest', name: 'Fleet', dsn: 'https://k@upmetrics.org/fleettest', apiKey: 'uk_fleet', platform: 'node', retentionDays: 30, agentRetentionDays: 90, createdAt: new Date(), updatedAt: new Date() })
    .run();
  run({ projectId: 'fleettest', agentName: 'buddy', costUsd: 3.0, tags: { transport: 'http' } });
  run({ projectId: 'fleettest', agentName: 'trail', costUsd: 1.5, tags: { transport: 'http' } });

  registerCostRoutes(app);
});

function get(path: string, key: string | null = KEY) {
  return app.request(path, { headers: key ? { 'x-upmetrics-key': key } : {} });
}
function getFleet(path: string, fleetKey: string | null = 'fleet_test_key') {
  return app.request(path, { headers: fleetKey ? { 'x-upmetrics-fleet-key': fleetKey } : {} });
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

describe('multi-tenant cost slicing (tags.tenantId)', () => {
  it('?tag.tenantId=<id> filters to one tenant', async () => {
    const b = await json(await get('/api/cost/summary?tag.tenantId=sanne', MULTI_KEY));
    expect(b.run_count).toBe(2);
    expect(b.total_micro_usd).toBe(30000); // (0.01 + 0.02)
    const bob = await json(await get('/api/cost/summary?tag.tenantId=bob', MULTI_KEY));
    expect(bob.run_count).toBe(1);
    expect(bob.total_micro_usd).toBe(40000);
  });

  it('?groupBy=tenantId breaks cost down per tenant', async () => {
    const b = await json(await get('/api/cost/summary?groupBy=tenantId', MULTI_KEY));
    expect(b.group_by).toBe('tenantId');
    const byTenant = Object.fromEntries(b.by_group.map((x: any) => [x.key, x.micro_usd]));
    expect(byTenant.sanne).toBe(30000);
    expect(byTenant.bob).toBe(40000);
  });

  it('no by_group key when groupBy is absent', async () => {
    const b = await json(await get('/api/cost/summary', MULTI_KEY));
    expect(b.by_group).toBeUndefined();
    expect(b.group_by).toBeUndefined();
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

describe('GET /api/cost/fleet (org read-token, cross-project per-agent)', () => {
  it('401 without the fleet key', async () => {
    expect((await getFleet('/api/cost/fleet', null)).status).toBe(401);
  });

  it('401 with a wrong fleet key (and a project key does NOT satisfy it)', async () => {
    expect((await getFleet('/api/cost/fleet', 'nope')).status).toBe(401);
    // a valid PROJECT key in the project header must not authorize the org endpoint
    expect((await app.request('/api/cost/fleet', { headers: { 'x-upmetrics-key': KEY } })).status).toBe(401);
  });

  it('aggregates per agent ACROSS projects with the org key', async () => {
    const r = await getFleet('/api/cost/fleet?window=1d');
    expect(r.status).toBe(200);
    const b = await json(r);
    const byAgent = Object.fromEntries(b.by_agent.map((a: any) => [a.agent_name, a]));
    // distinct agents from the fleettest project surface (cross-project read)
    expect(byAgent.buddy.micro_usd).toBe(3_000_000);
    expect(byAgent.buddy.runs).toBe(1);
    expect(byAgent.trail.micro_usd).toBe(1_500_000);
    // the org total spans every project (incl. the 9.99 'other' run) — proves no scope
    expect(b.total_micro_usd).toBeGreaterThanOrEqual(3_000_000 + 1_500_000 + 9_990_000);
    expect(b.total_usd).toBeGreaterThan(14);
  });

  it('1d window alias resolves (≈24h span)', async () => {
    const b = await json(await getFleet('/api/cost/fleet?window=1d'));
    const span = new Date(b.window.to).getTime() - new Date(b.window.from).getTime();
    expect(span).toBe(86_400_000);
  });
});
