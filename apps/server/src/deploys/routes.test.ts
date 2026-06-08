// F019.8 deploy-event ingest + release registry. Run: bun test src/deploys/routes.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { and, eq } from 'drizzle-orm';
import { getDb, schema } from '../db';
import { registerDeployRoutes } from './routes';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
// Namespaced ids — this file shares the getDb() singleton with sibling route tests.
const KEY = 'uk_dep_trail';
const app = new Hono();

beforeAll(() => {
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  const now = new Date();
  db.insert(schema.projects)
    .values({ id: 'dep_trail', name: 'dep_trail', dsn: 'https://k@upmetrics.org/dep_trail', apiKey: KEY, platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: now, updatedAt: now })
    .run();
  registerDeployRoutes(app);
});

const req = (path: string, key: string | null, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(key ? { 'x-upmetrics-key': key } : {}), 'content-type': 'application/json' } });
const json = (r: Response) => r.json() as Promise<any>;
const post = (body: object, key: string | null = KEY) => req('/api/deploys', key, { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/deploys (ingest)', () => {
  it('401 without a key', async () => {
    expect((await post({ site: 'a.dk', status: 'success' }, null)).status).toBe(401);
  });

  it('400 on missing fields', async () => {
    expect((await post({ site: 'a.dk' })).status).toBe(400);
    expect((await post({ status: 'success' })).status).toBe(400);
  });

  it('400 on invalid status', async () => {
    expect((await post({ site: 'a.dk', status: 'exploded' })).status).toBe(400);
  });

  it('inserts a new deploy and upserts in place on the same deploy_id', async () => {
    const r1 = await json(await post({ site: 'up.dk', deploy_id: 'd1', status: 'pending', sha: 'abc', originator: 'cms#42' }));
    expect(r1.deduped).toBe(false);
    const r2 = await json(await post({ site: 'up.dk', deploy_id: 'd1', status: 'success', sha: 'abc', version: 'v9' }));
    expect(r2.deduped).toBe(true);
    expect(r2.id).toBe(r1.id); // same row updated in place

    const rows = getDb().select().from(schema.deployEvents).where(eq(schema.deployEvents.deployId, 'd1')).all();
    expect(rows.length).toBe(1); // transitions update, never duplicate
    expect(rows[0]!.status).toBe('success');
    expect(rows[0]!.version).toBe('v9');
    expect(rows[0]!.originator).toBe('cms#42'); // merge: a status-only update preserves the originator
  });

  it('a null deploy_id always inserts a fresh row (anonymous deploys never collide)', async () => {
    await post({ site: 'anon.dk', status: 'success' });
    await post({ site: 'anon.dk', status: 'success' });
    const rows = getDb().select().from(schema.deployEvents).where(eq(schema.deployEvents.site, 'anon.dk')).all();
    expect(rows.length).toBe(2);
  });
});

describe('GET /release/:site (F019.8 registry)', () => {
  it('404 when the site has no success', async () => {
    await post({ site: 'pending-only.dk', deploy_id: 'po1', status: 'pending' });
    expect((await req('/release/pending-only.dk', null)).status).toBe(404);
  });

  it('returns version/sha/deployedAt for the latest success', async () => {
    await post({ site: 'reg.dk', deploy_id: 'r1', status: 'success', sha: 'sha1', version: 'v1' });
    await Bun.sleep(3); // distinct updatedAt ms so "latest" is deterministic
    await post({ site: 'reg.dk', deploy_id: 'r2', status: 'success', sha: 'sha2', version: 'v2' });

    const r = await req('/release/reg.dk', null);
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b).toMatchObject({ site: 'reg.dk', version: 'v2', sha: 'sha2' });
    expect(typeof b.deployedAt).toBe('string'); // ISO 8601
    expect(Number.isNaN(Date.parse(b.deployedAt))).toBe(false);
  });

  it('a newer pending does not override the latest success in the registry', async () => {
    await post({ site: 'reg.dk', deploy_id: 'r3', status: 'pending', sha: 'sha3', version: 'v3' });
    const b = await json(await req('/release/reg.dk', null));
    expect(b.version).toBe('v2'); // still the last SUCCESS, not the in-flight v3
  });
});
