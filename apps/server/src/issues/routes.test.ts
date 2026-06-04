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
const app = new Hono();

beforeAll(() => {
  const db = getDb();
  migrate(db, { migrationsFolder: MIGRATIONS });
  const now = new Date();
  const proj = (id: string, key: string) =>
    db.insert(schema.projects).values({ id, name: id, dsn: `https://k@upmetrics.org/${id}`, apiKey: key, platform: 'web', retentionDays: 30, agentRetentionDays: 90, createdAt: now, updatedAt: now }).run();
  proj('isr_trail', KEY);
  proj('isr_other', OTHER);
  const iss = (id: string, projectId: string, status: string) =>
    db.insert(schema.issues).values({ id, projectId, fingerprint: `fp_${id}`, title: `boom ${id}`, culprit: 'src/x.ts', level: 'error', status, firstSeen: now, lastSeen: now, eventCount: 3 }).run();
  iss('isr1', 'isr_trail', 'unresolved');
  iss('isr2', 'isr_trail', 'resolved');
  iss('isr3', 'isr_other', 'unresolved'); // must never be visible/resolvable via trail key
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
