// Agent-run ingest validation posture (sink contract for @broberg/ai-sdk).
// Run: bun test src/ingest/agent.test.ts
// Proves: types validated (bad type → 400), value-space OPEN (any tier accepted),
// unknown top-level keys swept into tags (nothing silently dropped), required
// identity enforced, auth enforced.
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { registerAgentRoutes } from './agent';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const KEY = 'uk_test';
const NOW = new Date('2026-06-02T12:00:00Z');
const app = new Hono();

beforeAll(() => {
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  db.insert(schema.projects)
    .values({
      id: 'p1',
      name: 'p1',
      dsn: 'https://k_p1@upmetrics.org/p1',
      apiKey: KEY,
      platform: 'web',
      retentionDays: 30,
      agentRetentionDays: 90,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  registerAgentRoutes(app);
});

function post(body: unknown, key: string | null = KEY) {
  return app.request('/api/agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-upmetrics-key': key } : {}) },
    body: JSON.stringify(body),
  });
}
async function body(res: Response): Promise<{ run_id: string; error?: string }> {
  return (await res.json()) as { run_id: string; error?: string };
}
const base = { agent_kind: 'chatbot', agent_name: 'cms', provider: 'google', model: 'gemini-2.0-flash' };

function rowById(id: string) {
  return getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.id, id)).get();
}

describe('POST /api/agent — validation posture', () => {
  it('401s on missing/invalid api key', async () => {
    const res = await post(base, null);
    expect(res.status).toBe(401);
  });

  it('400s when a required identity field is missing', async () => {
    const res = await post({ ...base, agent_name: undefined });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('missing_fields');
  });

  it('400s on a bad-typed metric (cost_usd:"abc" → not finite), never stores NaN', async () => {
    const res = await post({ ...base, cost_usd: 'abc' });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('invalid_body');
  });

  it('accepts an OPEN tier the schema never enumerated (cheap/vision) + defaults tokens', async () => {
    const res = await post({ ...base, tier: 'vision', cost_usd: 0.0001 });
    expect(res.status).toBe(200);
    const row = rowById((await body(res)).run_id)!;
    expect(row.tier).toBe('vision');
    expect(row.inputTokens).toBe(0); // omitted → default 0, not undefined
    expect(row.costUsd).toBeCloseTo(0.0001);
  });

  it('sweeps unknown top-level keys into tags (nothing silently dropped)', async () => {
    const res = await post({
      ...base,
      tier: 'cheap',
      latencyMs: 1200, // unknown top-level — must NOT vanish
      capability: 'translate', // unknown top-level
      tags: { transport: 'http' }, // explicit tags preserved + merged
    });
    expect(res.status).toBe(200);
    const tags = rowById((await body(res)).run_id)!.tags as Record<string, unknown>;
    expect(tags.latencyMs).toBe(1200);
    expect(tags.capability).toBe('translate');
    expect(tags.transport).toBe('http'); // explicit tag survives the merge
  });

  it('coerces numeric strings on tokens (lenient where it is safe)', async () => {
    const res = await post({ ...base, input_tokens: '420', output_tokens: '180' });
    expect(res.status).toBe(200);
    const row = rowById((await body(res)).run_id)!;
    expect(row.inputTokens).toBe(420);
    expect(row.outputTokens).toBe(180);
  });
});
