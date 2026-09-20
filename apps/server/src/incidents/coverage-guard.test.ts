// F033.2 — the guard that shouts when a project can ring nowhere.
// Run: bun test src/incidents/coverage-guard.test.ts
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeEach, beforeAll, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, getDb, schema, type Db } from '../db';
import { auth } from '../auth';
import { registerDashboardRoutes } from '../dashboard/routes';
import { runCoverageGuard, uncoveredProjects, buildCoverageMessage, _resetCoverageGuardState } from './coverage-guard';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;

// Count DELIVERIES, not intentions. The real sendFleet short-circuits on an
// empty webhook and never reaches fetch, so a fetch-spy would read zero here and
// every assertion would pass for the wrong reason.
let sent: string[] = [];
const spy = async (_url: string, message: string) => {
  sent.push(message);
};

function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string): void {
  db.insert(schema.projects)
    .values({ id, name: id, dsn: `https://k@upmetrics.org/${id}`, apiKey: `uk_${id}`, platform: 'web', createdAt: new Date(), updatedAt: new Date() })
    .run();
}
function addRule(db: Db, projectId: string, enabled = true): void {
  db.insert(schema.alertRules)
    .values({ id: `rule_${projectId}`, projectId, kind: '*', condition: null, channels: ['discord'], enabled, createdAt: new Date() })
    .run();
}

beforeEach(() => {
  _resetCoverageGuardState();
  sent = [];
});

describe('F033.2 coverage guard', () => {
  it('finds only projects with NO enabled rule — a disabled rule still counts as uncovered', () => {
    const db = freshDb();
    addProject(db, 'covered');
    addRule(db, 'covered', true);
    addProject(db, 'switched-off');
    addRule(db, 'switched-off', false); // a row exists, but it rings nowhere
    addProject(db, 'bare');

    expect(uncoveredProjects(db).map((p) => p.id).sort()).toEqual(['bare', 'switched-off']);
  });

  it('sends ONE message naming them all, not one per project', async () => {
    const db = freshDb();
    for (const id of ['a', 'b', 'c']) addProject(db, id);

    const res = await runCoverageGuard(db, new Date(), spy);
    expect(res.uncovered).toBe(3);
    expect(res.sent).toBe(true);
    expect(sent.length).toBe(1); // ← 3 projects, 1 delivery
    for (const id of ['a', 'b', 'c']) expect(sent[0]).toContain(id);
  });

  it('SENDS NOTHING when every project is covered — the negative control', async () => {
    const db = freshDb();
    addProject(db, 'covered');
    addRule(db, 'covered', true);

    const res = await runCoverageGuard(db, new Date(), spy);
    expect(res.uncovered).toBe(0);
    expect(res.sent).toBe(false);
    expect(sent.length).toBe(0);
  });

  it('is silent on an unchanged set, and speaks again when a NEW project falls into it', async () => {
    const db = freshDb();
    addProject(db, 'a');

    expect((await runCoverageGuard(db, new Date(), spy)).sent).toBe(true);
    expect((await runCoverageGuard(db, new Date(), spy)).sent).toBe(false); // same set → quiet
    expect(sent.length).toBe(1);

    addProject(db, 'b'); // the set changed — that is news
    const third = await runCoverageGuard(db, new Date(), spy);
    expect(third.sent).toBe(true);
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain('b');
  });

  it('switching a covered project OFF takes it from silent to named', async () => {
    const db = freshDb();
    addProject(db, 'quiet');
    addRule(db, 'quiet', true);
    expect((await runCoverageGuard(db, new Date(), spy)).sent).toBe(false);
    expect(sent.length).toBe(0);

    db.update(schema.alertRules).set({ enabled: false }).where(eq(schema.alertRules.projectId, 'quiet')).run();
    const after = await runCoverageGuard(db, new Date(), spy);
    expect(after.sent).toBe(true);
    expect(after.projectIds).toEqual(['quiet']);
    expect(sent[0]).toContain('quiet');
  });

  it('the message says what it means, in one line a human can act on', () => {
    const db = freshDb();
    addProject(db, 'bid');
    const msg = buildCoverageMessage(uncoveredProjects(db));
    expect(msg.split('\n')[0]).toBe('1 project can raise an incident that reaches NOBODY');
  });
});

// The guard is worthless if it only exists. These prove it is WIRED — the
// dashboard surface an owner actually opens carries the state, per project and
// as a fleet total. Remove the field from the route and these go red.
describe('F033.2 the owner can SEE which projects are silent', () => {
  const app = new Hono();

  beforeAll(() => {
    migrate(getDb(), { migrationsFolder: MIGRATIONS });
    spyOn(auth.api, 'getSession').mockResolvedValue({ user: { email: 'cb@webhouse.dk' } } as never);
    registerDashboardRoutes(app);

    const db = getDb();
    addProject(db, 'rings');
    addRule(db, 'rings', true);
    addProject(db, 'silent');
    addRule(db, 'silent', false); // a row that rings nowhere
  });

  it('/api/dashboard/overview marks every project, and totals the silent ones', async () => {
    const res = await app.request('/api/dashboard/overview');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projects: Array<{ id: string; alerts_covered: boolean }>;
      totals: { alerts_uncovered: number };
    };

    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p.alerts_covered]));
    expect(byId['rings']).toBe(true);
    expect(byId['silent']).toBe(false); // disabled rule ⇒ still silent
    expect(body.totals.alerts_uncovered).toBe(body.projects.filter((p) => !p.alerts_covered).length);
    expect(body.totals.alerts_uncovered).toBeGreaterThan(0);
  });
});

// A guard nothing calls is not a guard. Removing the line from the worker tick
// is invisible to the typechecker and to every behavioural test above — measured:
// deleting it produced 0 type errors and 0 red tests. So the call site itself is
// asserted. This proves the LINE EXISTS, not that the tick fires; the behaviour
// is covered by the tests above, and this covers the wire between them.
describe('F033.2 the guard is wired into the worker tick', () => {
  it('correlation.ts calls runCoverageGuard', async () => {
    const src = await Bun.file(new URL('./correlation.ts', import.meta.url).pathname).text();
    expect(src).toContain('runCoverageGuard(db)');
  });
});
