// F010.7 self-service issue list + resolve. Run: bun test src/issues/routes.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getDb, schema } from '../db';
import { registerIssueRoutes } from './routes';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
// Namespaced ids ('isr_*') — this file shares the getDb() singleton with sibling
// route tests (cost), so generic ids like 'other' would collide. Keep unique.
const KEY = 'uk_isr_trail';
const OTHER = 'uk_isr_other';
const PRE = 'uk_isr_pre';
const app = new Hono();

beforeAll(() => {
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  const now = new Date();
  const proj = (id: string, key: string) =>
    db.insert(schema.projects).values({ id, name: id, dsn: `https://k@upmetrics.org/${id}`, apiKey: key, platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: now, updatedAt: now }).run();
  proj('isr_trail', KEY);
  proj('isr_other', OTHER);
  proj('isr_pre', PRE); // isolates prefix-resolve issues from resolve-all's count
  const iss = (id: string, projectId: string, status: string) =>
    db.insert(schema.issues).values({ id, projectId, fingerprint: `fp_${id}`, title: `boom ${id}`, culprit: 'src/x.ts', level: 'error', status, firstSeen: now, lastSeen: now, eventCount: 3 }).run();
  iss('isr1', 'isr_trail', 'unresolved');
  iss('isr2', 'isr_trail', 'resolved');
  iss('isr3', 'isr_other', 'unresolved'); // must never be visible/resolvable via trail key
  // UUID-id issues for prefix-resolve (dashboard shows the first 8 chars).
  iss('abcd1234-aaaa-4aaa-8aaa-000000000001', 'isr_pre', 'unresolved'); // unique prefix 'abcd1234'
  iss('dead0001-bbbb-4bbb-8bbb-000000000002', 'isr_pre', 'unresolved'); // shares 'dead000' …
  iss('dead0002-cccc-4ccc-8ccc-000000000003', 'isr_pre', 'unresolved'); // … with this → ambiguous
  registerIssueRoutes(app);
});

const req = (path: string, key: string | null, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { ...(key ? { 'x-upmetrics-key': key } : {}), 'content-type': 'application/json' } });
const json = (r: Response) => r.json() as Promise<any>;

describe('GET /api/issues', () => {
  it('401 without a key', async () => {
    expect((await req('/api/issues', null)).status).toBe(401);
  });
  it('lists only your project unresolved issues by default', async () => {
    const b = await json(await req('/api/issues', KEY));
    expect(b.project).toBe('isr_trail');
    expect(b.issues.map((i: any) => i.id)).toEqual(['isr1']); // isr2 resolved, isr3 other-project
  });
  it('?status= filters exactly', async () => {
    const b = await json(await req('/api/issues?status=resolved', KEY));
    expect(b.issues.map((i: any) => i.id)).toEqual(['isr2']);
  });
});

describe('POST /api/issues/:id/resolve', () => {
  it("404 for another project's issue (scoped to your key)", async () => {
    expect((await req('/api/issues/isr3/resolve', KEY, { method: 'POST', body: '{}' })).status).toBe(404);
  });
  it('resolves your own issue (default status=resolved)', async () => {
    const r = await req('/api/issues/isr1/resolve', KEY, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    expect((await json(r)).status).toBe('resolved');
    expect(getDb().select().from(schema.issues).where(eq(schema.issues.id, 'isr1')).get()!.status).toBe('resolved');
  });
  it('accepts status=ignored', async () => {
    const r = await json(await req('/api/issues/isr2/resolve', KEY, { method: 'POST', body: JSON.stringify({ status: 'ignored' }) }));
    expect(r.status).toBe('ignored');
  });

  it('resolves by a UNIQUE id-prefix (the dashboard short id)', async () => {
    const r = await req('/api/issues/abcd1234/resolve', PRE, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    const b = await json(r);
    expect(b.id).toBe('abcd1234-aaaa-4aaa-8aaa-000000000001'); // resolved by full id
    expect(b.status).toBe('resolved');
  });

  it('409 on an AMBIGUOUS prefix — never resolves the wrong issue', async () => {
    const r = await req('/api/issues/dead000/resolve', PRE, { method: 'POST', body: '{}' });
    expect(r.status).toBe(409);
    expect((await json(r)).error).toBe('ambiguous_prefix');
  });

  it('a non-hex param is never treated as a prefix (still 404, scoping intact)', async () => {
    expect((await req('/api/issues/isr3/resolve', KEY, { method: 'POST', body: '{}' })).status).toBe(404);
  });
});

describe('POST /api/issues/resolve-all (clear slate)', () => {
  it('resolves all open issues for the caller project only', async () => {
    const db = getDb();
    const now = new Date();
    const seed = (id: string, projectId: string) =>
      db.insert(schema.issues).values({ id, projectId, fingerprint: `fp_${id}`, title: `flood ${id}`, culprit: 'x', level: 'error', status: 'unresolved', firstSeen: now, lastSeen: now, eventCount: 99 }).run();
    seed('ra1', 'isr_trail');
    seed('ra2', 'isr_trail');
    seed('ra_other', 'isr_other'); // another project — must be untouched

    const r = await json(await req('/api/issues/resolve-all', KEY, { method: 'POST', body: '{}' }));
    expect(r.resolved).toBe(2); // only isr_trail's two fresh open (earlier ones already resolved/ignored)
    expect(r.status).toBe('resolved');
    expect(db.select().from(schema.issues).where(eq(schema.issues.id, 'ra1')).get()!.status).toBe('resolved');
    expect(db.select().from(schema.issues).where(eq(schema.issues.id, 'ra_other')).get()!.status).toBe('unresolved'); // scoped
  });
});

import { eq } from 'drizzle-orm';

// ── F026 — the other half of the self-service contract ──────────────────────
describe('F026 incidents + issue detail', () => {
  const now = new Date();
  beforeAll(() => {
    const db = getDb();
    db.insert(schema.events)
      .values({ id: 'ev_f026_1', projectId: 'isr_trail', kind: 'error', receivedAt: now, occurredAt: now, issueId: 'isr1', release: 'r1', environment: 'production', tags: { runtime: 'server' },
        payload: { exception: { values: [{ type: 'TypeError', value: 'x is not a function', stacktrace: { frames: [{ function: 'f', filename: '/a.ts', lineno: 3, colno: 1 }] } }] } } })
      .run();
    // Frameless on purpose: an event that arrived with no origin is a real
    // answer, and the route must show the emptiness rather than hide it.
    db.insert(schema.events)
      .values({ id: 'ev_f026_2', projectId: 'isr_trail', kind: 'error', receivedAt: new Date(now.getTime() - 1000), occurredAt: now, issueId: 'isr1', release: 'r1',
        payload: { exception: { values: [{ type: 'TimeoutError', value: 'timed out', stacktrace: { frames: [] } }] } } })
      .run();
    const inc = (id: string, projectId: string, status: string) =>
      db.insert(schema.incidents).values({ id, projectId, kind: 'deploy_regression', status, severity: 'high', title: `regressed ${id}`, openedAt: now, triggerRef: 'dep_x' }).run();
    inc('incA', 'isr_trail', 'open');
    inc('incB', 'isr_trail', 'resolved');
    inc('incC', 'isr_other', 'open'); // never visible via the trail key
  });

  it('status=all returns every issue — it used to return an empty list', async () => {
    // The bug cms found: "all" was compared against each row's status, matched
    // nothing, and answered [] — which reads as "no errors" to the caller.
    // Asserted against the DATABASE, not against another route's answer: an
    // earlier test in this file resolves issues, so any count derived from the
    // default view depends on test order. The property is "all means all".
    const rows = getDb().select().from(schema.issues).where(eq(schema.issues.projectId, 'isr_trail')).all();
    expect(rows.length).toBeGreaterThan(1);
    const all = (await (await req('/api/issues?status=all', KEY)).json()) as { issues: unknown[] };
    expect(all.issues.length).toBe(rows.length);
    // And it is genuinely wider than the default, which is the half that broke.
    const dflt = (await (await req('/api/issues', KEY)).json()) as { issues: unknown[] };
    expect(all.issues.length).toBeGreaterThan(dflt.issues.length);
  });

  it('GET /api/issues/:id gives the stack, release and tags behind the issue', async () => {
    const r = await req('/api/issues/isr1', KEY);
    expect(r.status).toBe(200);
    const b = (await r.json()) as { id: string; latest_event: { type: string; release: string; tags: unknown; frames: unknown[] } };
    expect(b.id).toBe('isr1');
    expect(b.latest_event.type).toBe('TypeError');
    expect(b.latest_event.release).toBe('r1');
    expect(b.latest_event.tags).toEqual({ runtime: 'server' });
    expect(b.latest_event.frames.length).toBe(1);
  });

  it('GET /api/issues/:id/events lists them newest first, and keeps an empty stack visible', async () => {
    const b = (await (await req('/api/issues/isr1/events', KEY)).json()) as { count: number; events: { id: string; frames: unknown[] }[] };
    expect(b.count).toBe(2);
    expect(b.events[0]!.id).toBe('ev_f026_1'); // newest first
    expect(b.events[1]!.frames).toEqual([]); // emptiness shown, not smoothed to null
  });

  it('another project’s issue is not readable', async () => {
    expect((await req('/api/issues/isr3', KEY)).status).toBe(404);
    expect((await req('/api/issues/isr3/events', KEY)).status).toBe(404);
  });

  it('lists only YOUR open incidents by default', async () => {
    const b = (await (await req('/api/incidents', KEY)).json()) as { incidents: { id: string }[] };
    const ids = b.incidents.map((i) => i.id);
    expect(ids).toContain('incA');
    expect(ids).not.toContain('incB'); // resolved
    expect(ids).not.toContain('incC'); // another project
  });

  it('status=all on incidents includes the resolved ones', async () => {
    const b = (await (await req('/api/incidents?status=all', KEY)).json()) as { incidents: { id: string }[] };
    const ids = b.incidents.map((i) => i.id);
    expect(ids).toContain('incA');
    expect(ids).toContain('incB');
    expect(ids).not.toContain('incC');
  });

  it('resolves one of your incidents, and the DATABASE agrees', async () => {
    const r = await req('/api/incidents/incA/resolve', KEY, { method: 'POST', body: '{}' });
    expect(r.status).toBe(200);
    // Read back from the row, never from the handler's own reply.
    const row = getDb().select().from(schema.incidents).where(eq(schema.incidents.id, 'incA')).get()!;
    expect(row.status).toBe('resolved');
    expect(row.resolvedAt).toBeTruthy();
  });

  it('cannot resolve another project’s incident', async () => {
    expect((await req('/api/incidents/incC/resolve', KEY, { method: 'POST', body: '{}' })).status).toBe(404);
    const row = getDb().select().from(schema.incidents).where(eq(schema.incidents.id, 'incC')).get()!;
    expect(row.status).toBe('open'); // untouched
  });

  it('no key is 401 on every new route', async () => {
    expect((await req('/api/issues/isr1', null)).status).toBe(401);
    expect((await req('/api/issues/isr1/events', null)).status).toBe(401);
    expect((await req('/api/incidents', null)).status).toBe(401);
    expect((await req('/api/incidents/incA/resolve', null, { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('F026 — an unknown status filter is an error, not an empty list', () => {
  // super, 2026-08-31: "hvad gør ?status=all nu hvis status-værdien er ukendt?
  // Svarer den [] igen, står den samme fælde bare et skridt til siden."
  // They were right: fixing 'all' alone left ?status=vrøvl answering [], and in
  // an error-tracking API an empty array reads as "nothing is wrong".
  it('issues: 400 with the valid values, never []', async () => {
    const r = await req('/api/issues?status=vroevl', KEY);
    expect(r.status).toBe(400);
    const b = (await r.json()) as { error: string; valid: string[] };
    expect(b.error).toBe('unknown_status');
    expect(b.valid).toContain('all');
    expect(b.valid).toContain('unresolved');
  });

  it('incidents: same', async () => {
    const r = await req('/api/incidents?status=vroevl', KEY);
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe('unknown_status');
  });

  it('the KNOWN values still work — the guard did not close the door', async () => {
    expect((await req('/api/issues?status=all', KEY)).status).toBe(200);
    expect((await req('/api/issues?status=resolved', KEY)).status).toBe(200);
    expect((await req('/api/issues', KEY)).status).toBe(200);
    expect((await req('/api/incidents?status=all', KEY)).status).toBe(200);
    expect((await req('/api/incidents?status=open', KEY)).status).toBe(200);
  });
});
