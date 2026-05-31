// F007.2 ingest guardrails. Run: bun test src/ops/guard.test.ts
import { describe, it, expect, beforeEach } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq } from 'drizzle-orm';
import { createDb, schema, type Db } from '../db';
import { guardIngest, _resetGuardState } from './guard';

const MIGRATIONS = new URL('../db/migrations', import.meta.url).pathname;
const NOW = Date.now();
let seq = 0;

function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}
function addProject(db: Db, id: string, opts: Partial<typeof schema.projects.$inferInsert> = {}): typeof schema.projects.$inferSelect {
  db.insert(schema.projects)
    .values({
      id,
      name: id,
      dsn: `https://k_${id}@upmetrics.org/${id}`,
      apiKey: `uk_${id}`,
      platform: 'web',
      rateLimitPerMin: 1200,
      storageMaxEvents: 500000,
      createdAt: new Date(NOW),
      updatedAt: new Date(NOW),
      ...opts,
    })
    .run();
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
}
function addEvents(db: Db, projectId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    db.insert(schema.events)
      .values({ id: `ev_${++seq}`, projectId, kind: 'error', receivedAt: new Date(NOW), occurredAt: new Date(NOW), payload: {} })
      .run();
  }
}
beforeEach(() => _resetGuardState());

describe('F007.2 ingest guard', () => {
  it('AC0: per-project rate limit rejects bursts above events/min (read from project row)', () => {
    const db = freshDb();
    const p = addProject(db, 'a', { rateLimitPerMin: 5 });
    expect(guardIngest(db, p, 3, NOW).accept).toBe(true); // 3/5
    const over = guardIngest(db, p, 3, NOW + 1000); // 3+3=6 > 5
    expect(over.accept).toBe(false);
    expect(over.reason).toBe('rate');
    // a fresh minute window resets
    expect(guardIngest(db, p, 3, NOW + 61_000).accept).toBe(true);
  });

  it('AC1: storage cap drops new data with EXACTLY ONE warning event', () => {
    const db = freshDb();
    const p = addProject(db, 'a', { storageMaxEvents: 2 });
    addEvents(db, 'a', 2); // at cap
    const d1 = guardIngest(db, p, 1, NOW);
    expect(d1.accept).toBe(false);
    expect(d1.reason).toBe('storage');
    const d2 = guardIngest(db, p, 1, NOW + 1000); // still over, within warn window
    expect(d2.accept).toBe(false);
    // exactly one guard warning event was emitted
    const warns = db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'message'))
      .all()
      .filter((e) => (e.tags as { upmetrics_guard?: string } | null)?.upmetrics_guard);
    expect(warns.length).toBe(1);
  });

  it('AC2: changing the project limit takes effect with no redeploy', () => {
    const db = freshDb();
    let p = addProject(db, 'a', { rateLimitPerMin: 2 });
    expect(guardIngest(db, p, 3, NOW).accept).toBe(false); // 3 > 2
    // operator raises the limit on the project row (no redeploy)
    db.update(schema.projects).set({ rateLimitPerMin: 100 }).where(eq(schema.projects.id, 'a')).run();
    p = db.select().from(schema.projects).where(eq(schema.projects.id, 'a')).get()!;
    _resetGuardState();
    expect(guardIngest(db, p, 3, NOW + 120_000).accept).toBe(true); // now allowed
  });
});
