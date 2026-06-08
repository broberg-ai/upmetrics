// F019.7 deploy-complete relay pull-feed. Run: bun test src/deploys/relay.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { config } from '../config';
import { registerDeployRelayRoutes } from './relay';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const TOKEN = 'relay-token-test';
const app = new Hono();

beforeAll(() => {
  // ESM hoisting: config reads env at import, so set the token on the live object.
  Object.assign(config, { remediationRelayToken: TOKEN });
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  const now = new Date();
  db.insert(schema.projects)
    .values({ id: 'dr_proj', name: 'dr_proj', dsn: 'https://k@upmetrics.org/dr_proj', apiKey: 'uk_dr_proj', platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: now, updatedAt: now })
    .run();
  const dep = (id: string, status: string, originator: string | null, relayedAt: Date | null) =>
    db.insert(schema.deployEvents)
      .values({ id, projectId: 'dr_proj', site: `${id}.dk`, deployId: id, provider: 'fly', status, sha: 'sha', version: 'v1', originator, relayedAt, createdAt: now, updatedAt: now })
      .run();
  dep('dr_ok', 'success', 'cms#1', null); // eligible
  dep('dr_noorig', 'success', null, null); // no originator → cannot route
  dep('dr_pending', 'pending', 'cms#2', null); // not terminal
  dep('dr_done', 'failure', 'cms#3', now); // already relayed
  registerDeployRelayRoutes(app);
});

const get = (path: string, token: string | null) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const post = (path: string, token: string | null) =>
  app.request(path, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
const json = (r: Response) => r.json() as Promise<any>;

describe('GET /api/deploys/pending-relays', () => {
  it('401 without the bearer token', async () => {
    expect((await get('/api/deploys/pending-relays', null)).status).toBe(401);
    expect((await get('/api/deploys/pending-relays', 'wrong')).status).toBe(401);
  });

  it('returns only terminal + has-originator + not-yet-relayed deploys', async () => {
    // The feed is global (no project filter) + shares the in-memory db singleton
    // with sibling test files, so assert on membership, not exclusivity.
    const b = await json(await get('/api/deploys/pending-relays', TOKEN));
    const ids = b.deploys.map((d: any) => d.deploy_row_id);
    expect(ids).toContain('dr_ok'); // terminal + originator + unrelayed
    expect(ids).not.toContain('dr_noorig'); // no originator → can't route
    expect(ids).not.toContain('dr_pending'); // not terminal
    expect(ids).not.toContain('dr_done'); // already relayed
    const ok = b.deploys.find((d: any) => d.deploy_row_id === 'dr_ok');
    expect(ok.originator).toBe('cms#1');
    expect(ok.status).toBe('success');
  });
});

describe('POST /api/deploys/:id/relayed (idempotent stamp)', () => {
  it('401 without the bearer token', async () => {
    expect((await post('/api/deploys/dr_ok/relayed', null)).status).toBe(401);
  });

  it('404 for an unknown deploy', async () => {
    expect((await post('/api/deploys/nope/relayed', TOKEN)).status).toBe(404);
  });

  it('stamps once, is idempotent, and drops the deploy from the feed', async () => {
    const first = await json(await post('/api/deploys/dr_ok/relayed', TOKEN));
    expect(first).toMatchObject({ ok: true, already_relayed: false });

    const again = await json(await post('/api/deploys/dr_ok/relayed', TOKEN));
    expect(again).toMatchObject({ ok: true, already_relayed: true }); // 1 relay per deploy

    const feed = await json(await get('/api/deploys/pending-relays', TOKEN));
    expect(feed.deploys.map((d: any) => d.deploy_row_id)).not.toContain('dr_ok'); // relayed → no longer pending
  });
});
