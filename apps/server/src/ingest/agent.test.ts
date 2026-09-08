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

describe('POST /api/agent — idempotency_key upsert (daily cost re-push)', () => {
  const KEY1 = 'buddy:2026-06-03:brain:opus';
  const rowsForKey = (k: string) =>
    getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.idempotencyKey, k)).all();

  it('first push with idempotency_key inserts (upserted:false)', async () => {
    const res = await post({ ...base, idempotency_key: KEY1, input_tokens: 100, cost_usd: 1.0 });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { run_id: string; upserted: boolean };
    expect(b.upserted).toBe(false);
    const rows = rowsForKey(KEY1);
    expect(rows.length).toBe(1);
    expect(rows[0]!.costUsd).toBeCloseTo(1.0);
  });

  it('re-push of the SAME key updates in place — no duplicate row, values replaced (upserted:true)', async () => {
    const res = await post({ ...base, idempotency_key: KEY1, input_tokens: 250, cost_usd: 2.5 });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { run_id: string; upserted: boolean };
    expect(b.upserted).toBe(true);
    const rows = rowsForKey(KEY1);
    expect(rows.length).toBe(1); // still ONE — no double-count
    expect(rows[0]!.costUsd).toBeCloseTo(2.5); // grown aggregate replaced in place
    expect(rows[0]!.inputTokens).toBe(250);
  });

  it('a different key inserts a separate row (per day×source×model cell)', async () => {
    const KEY2 = 'buddy:2026-06-03:review:haiku';
    const res = await post({ ...base, idempotency_key: KEY2, cost_usd: 0.3 });
    expect((await body(res)).run_id).toBeTruthy();
    expect(rowsForKey(KEY2).length).toBe(1);
    expect(rowsForKey(KEY1).length).toBe(1); // untouched
  });

  it('no idempotency_key still inserts normally (NULLs are distinct — no collision)', async () => {
    const a = await post({ ...base, cost_usd: 0.1 });
    const b = await post({ ...base, cost_usd: 0.2 });
    expect((await body(a)).run_id).not.toBe((await body(b)).run_id); // two distinct rows
  });
});

// F028.2 — the key a real sender can actually reach us with.
//
// The suite above sends `idempotency_key` at the top level, which is our
// documented field and the one path no @broberg/ai-sdk consumer can use: that
// SDK's cost-sink puts caller metadata into `tags`. So the tests were green on
// the route nobody takes, while the route everyone takes silently deduped
// nothing. Measured on prod 2026-09-08: 0 of 35,417 trail rows had the column
// filled, and their newest row carried the key in tags.
describe('POST /api/agent — dedup key arriving in tags (the SDK path)', () => {
  const TAGKEY = '67c02772-0bc0-4f19-bfff-505f436a2ac2:2026-09-08T11:38:56.850Z';
  const rowsForKey = (k: string) =>
    getDb().select().from(schema.agentRuns).where(eq(schema.agentRuns.idempotencyKey, k)).all();

  it('fills the column from tags.idempotencyKey when the top-level field is absent', async () => {
    const res = await post({ ...base, tags: { idempotencyKey: TAGKEY, tenantId: 't-broberg-ai' }, cost_usd: 0.5 });
    expect(res.status).toBe(200);
    // Read the stored row back, with strict equality — the response is the
    // handler's claim about what it wrote, not the database's answer.
    const rows = rowsForKey(TAGKEY);
    expect(rows.length).toBe(1);
    expect(rows[0]!.idempotencyKey).toBe(TAGKEY);
  });

  it('a re-delivery of the SAME tag key collapses into ONE row, carrying the second body', async () => {
    const res = await post({ ...base, tags: { idempotencyKey: TAGKEY, tenantId: 't-broberg-ai' }, cost_usd: 0.9 });
    expect((await res.json() as { upserted: boolean }).upserted).toBe(true);
    const rows = rowsForKey(TAGKEY);
    expect(rows.length).toBe(1);
    expect(rows[0]!.costUsd).toBeCloseTo(0.9);
  });

  // NEGATIVE CONTROL, in the same file on purpose: without it, "one row" is also
  // what a handler that refuses to insert anything would produce.
  it('a DIFFERENT tag key still inserts a separate row', async () => {
    const other = `${TAGKEY}-anden-koersel`;
    await post({ ...base, tags: { idempotencyKey: other }, cost_usd: 0.4 });
    expect(rowsForKey(other).length).toBe(1);
    expect(rowsForKey(TAGKEY).length).toBe(1); // untouched
  });

  it('the top-level field wins when both are set', async () => {
    const top = 'top-level-vinder';
    await post({ ...base, idempotency_key: top, tags: { idempotencyKey: 'tag-taber' }, cost_usd: 0.2 });
    expect(rowsForKey(top).length).toBe(1);
    expect(rowsForKey('tag-taber').length).toBe(0);
  });

  // A guessed key would merge two runs that are not the same run, so a value we
  // cannot read as a key must be null — never coerced, never thrown.
  it('a non-string or empty tags.idempotencyKey stores null, and does not throw', async () => {
    for (const bad of ['', 42, null, { a: 1 }]) {
      const res = await post({ ...base, tags: { idempotencyKey: bad }, cost_usd: 0.01 });
      expect(res.status).toBe(200);
      const row = rowById((await res.json() as { run_id: string }).run_id)!;
      expect(row.idempotencyKey).toBeNull();
    }
  });
});
