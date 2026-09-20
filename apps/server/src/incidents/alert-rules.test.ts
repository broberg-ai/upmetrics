// F033.1 — a project with no alert rule rings nowhere. Run: bun test src/incidents/alert-rules.test.ts
//
// Every assertion here READS THE ROW BACK from the database. A route that
// answers 201 and a route that answers 201 and wrote the rule are the same
// response, and the whole defect this card fixes is that the second one was
// never true.
process.env.DATABASE_PATH = ':memory:';

import { describe, it, expect, beforeAll, beforeEach, spyOn } from 'bun:test';
import { Hono } from 'hono';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, getDb, schema, type Db } from '../db';
import { ensureDefaultAlertRules, DEFAULT_ALERT_CHANNELS } from './alert-rules';
import { auth } from '../auth';
import { registerDashboardRoutes } from '../dashboard/routes';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;

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

const rulesFor = (db: Db, projectId: string) =>
  db.select().from(schema.alertRules).where(eq(schema.alertRules.projectId, projectId)).all();

describe('F033.1 ensureDefaultAlertRules', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('gives an uncovered project exactly one enabled rule on the fleet channels', () => {
    addProject(db, 'bid');
    expect(ensureDefaultAlertRules(db)).toBe(1);

    const rules = rulesFor(db, 'bid');
    expect(rules.length).toBe(1);
    expect(rules[0]!.kind).toBe('*');
    expect(rules[0]!.condition).toBe(null);
    expect(rules[0]!.channels).toEqual([...DEFAULT_ALERT_CHANNELS]);
    expect(rules[0]!.enabled).toBe(true);
  });

  it('is idempotent — a second call inserts nothing', () => {
    addProject(db, 'bid');
    addProject(db, 'components');
    expect(ensureDefaultAlertRules(db)).toBe(2);
    expect(ensureDefaultAlertRules(db)).toBe(0);
    expect(db.select().from(schema.alertRules).all().length).toBe(2);
  });

  it('never touches a project that already has a rule — INCLUDING a disabled one', () => {
    // A disabled rule is a choice somebody made. Inserting a fresh enabled row
    // beside it would hand back an alarm the owner deliberately switched off.
    addProject(db, 'quiet');
    db.insert(schema.alertRules)
      .values({ id: 'r1', projectId: 'quiet', kind: '*', condition: null, channels: ['discord'], enabled: false, createdAt: new Date() })
      .run();

    expect(ensureDefaultAlertRules(db)).toBe(0);
    const rules = rulesFor(db, 'quiet');
    expect(rules.length).toBe(1);
    expect(rules[0]!.enabled).toBe(false);
  });

  it('covers a project inserted BY HAND — the door no route can guard', () => {
    // This is how most fleet repos were actually enrolled, and why the sweep
    // runs at every boot instead of being a one-shot migration.
    addProject(db, 'hand-inserted');
    expect(rulesFor(db, 'hand-inserted').length).toBe(0);
    expect(ensureDefaultAlertRules(db)).toBe(1);
    expect(rulesFor(db, 'hand-inserted').length).toBe(1);
  });

  it('does nothing when there are no projects at all', () => {
    expect(ensureDefaultAlertRules(db)).toBe(0);
  });
});

describe('F033.1 the dashboard creation route', () => {
  const app = new Hono();

  beforeAll(() => {
    migrate(getDb(), { migrationsFolder: MIGRATIONS });
    // The route is session-gated; the session is not what this test measures.
    spyOn(auth.api, 'getSession').mockResolvedValue({ user: { email: 'cb@webhouse.dk' } } as never);
    registerDashboardRoutes(app);
  });

  it('a newly created project can ring — read back from the database, not the response', async () => {
    const res = await app.request('/api/dashboard/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'newborn', name: 'Newborn' }),
    });
    expect(res.status).toBe(201);

    const rules = rulesFor(getDb(), 'newborn');
    expect(rules.length).toBe(1);
    expect(rules[0]!.enabled).toBe(true);
    expect(rules[0]!.channels).toEqual([...DEFAULT_ALERT_CHANNELS]);
  });
});
