// F019.7 deploy-complete relay pull-feed. Run: bun test src/deploys/relay.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { config } from '../config';
import { registerDeployRelayRoutes, deployRelayMessage, pushDeployRelays, type DeployRelayItem } from './relay';

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

// F019.11 — push-relay message + dispatch.
const item = (over: Partial<DeployRelayItem>): DeployRelayItem => ({
  deploy_row_id: 'x', deploy_id: 'x', project: 'p', site: 'acme.dk', status: 'success',
  sha: 'abc1234def', version: 'v2', originator: 'acme', verdict: null, verdictReason: null,
  deployed_at: '2026-06-12T00:00:00.000Z', ...over,
});

describe('deployRelayMessage', () => {
  it('plain live ping when not yet health-evaluated', () => {
    const { message, severity } = deployRelayMessage(item({ version: 'v2' }));
    expect(message).toContain('acme.dk');
    expect(message).toContain('v2');
    expect(severity).toBe('info');
  });
  it('healthy verdict → info with health-OK note', () => {
    const { message, severity } = deployRelayMessage(item({ verdict: 'healthy' }));
    expect(message).toContain('health-check OK');
    expect(severity).toBe('info');
  });
  it('regressed verdict → warn carrying the reason + dashboard link', () => {
    const { message, severity } = deployRelayMessage(item({ verdict: 'regressed', verdictReason: 'errors 4× baseline' }));
    expect(message).toContain('regredierede');
    expect(message).toContain('errors 4× baseline');
    expect(message).toContain('upmetrics.org/deploys');
    expect(severity).toBe('warn');
  });
  it('failure status → warn, falls back to short sha when no version', () => {
    const { message, severity } = deployRelayMessage(item({ status: 'failure', version: null }));
    expect(message).toContain('fejlede');
    expect(message).toContain('abc1234'); // 7-char sha fallback
    expect(severity).toBe('warn');
  });
});

describe('pushDeployRelays', () => {
  it('stamps relayed on 200, leaves an offline (404) target unstamped for retry', async () => {
    const db = getDb();
    const now = new Date();
    Object.assign(config, { buddyCloudDispatchToken: 'push-token', buddyCloudDispatchUrl: 'https://buddycloud.test/x', deployRelayMaxAgeMs: 1_800_000 });
    const stale = new Date(now.getTime() - 3_600_000); // 1h ago → past the 30m window
    db.insert(schema.deployEvents)
      .values({ id: 'pp_on', projectId: 'dr_proj', site: 'on.dk', deployId: 'pp_on', provider: 'fly', status: 'success', sha: 's', version: 'v1', originator: 'pushok', relayedAt: null, createdAt: now, updatedAt: now })
      .run();
    db.insert(schema.deployEvents)
      .values({ id: 'pp_off', projectId: 'dr_proj', site: 'off.dk', deployId: 'pp_off', provider: 'fly', status: 'success', sha: 's', version: 'v1', originator: 'pushoffline', relayedAt: null, createdAt: now, updatedAt: now })
      .run();
    db.insert(schema.deployEvents)
      .values({ id: 'pp_stale', projectId: 'dr_proj', site: 'stale.dk', deployId: 'pp_stale', provider: 'fly', status: 'success', sha: 's', version: 'v1', originator: 'pushstale', relayedAt: null, createdAt: stale, updatedAt: stale })
      .run();

    const calls: any[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, opts: any) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, ...body, auth: opts.headers.authorization });
      const offline = String(body.to).includes('offline');
      return new Response(JSON.stringify(offline ? { routed: false, error: 'no_edge_for_session' } : { routed: true, edgeId: 'e1' }), { status: offline ? 404 : 200 });
    }) as any;

    try {
      const res = await pushDeployRelays(db, now);
      // Sent the right shape with the bearer token.
      const onCall = calls.find((c) => c.to === 'pushok');
      expect(onCall).toMatchObject({ to: 'pushok', from: 'upmetrics' });
      expect(onCall.auth).toBe('Bearer push-token');
      expect(onCall.message).toContain('on.dk');
      // 200 → stamped + dropped from the feed; 404 → still pending.
      expect(res.pushed).toBeGreaterThanOrEqual(1);
      expect(res.offline).toBeGreaterThanOrEqual(1);
      expect(res.suppressed).toBeGreaterThanOrEqual(1);
      // A stale deploy is suppressed without ever calling buddycloud.
      expect(calls.find((c) => c.to === 'pushstale')).toBeUndefined();
      const feed = await json(await get('/api/deploys/pending-relays', TOKEN));
      const ids = feed.deploys.map((d: any) => d.deploy_row_id);
      expect(ids).not.toContain('pp_on'); // 200 → relayed
      expect(ids).not.toContain('pp_stale'); // stale → suppressed (stamped, not pinged)
      expect(ids).toContain('pp_off'); // 404 → left for retry
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('is a no-op when the dispatch token is unset (pull-feed remains the path)', async () => {
    Object.assign(config, { buddyCloudDispatchToken: '' });
    const res = await pushDeployRelays(getDb(), new Date());
    expect(res).toEqual({ pushed: 0, offline: 0, failed: 0, suppressed: 0 });
  });
});
