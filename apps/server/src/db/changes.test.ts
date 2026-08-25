// Run: bun test src/db/changes.test.ts
//
// Proven against a REAL in-memory database, never a stub. The correctness of
// rowsChanged() rests on undocumented runtime behaviour (drizzle types `.run()`
// as void), so a drizzle upgrade that changes the shape must turn this RED
// rather than silently returning null forever.
import { describe, it, expect } from 'bun:test';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { eq, inArray } from 'drizzle-orm';
import { createDb, schema, type Db } from '../db';
import { rowsChanged } from './changes';

const MIGRATIONS = new URL('./migrations', import.meta.url).pathname;
const NOW = new Date('2026-08-25T12:00:00Z');

function freshDb(): Db {
  const db = createDb(':memory:');
  migrate(db, { migrationsFolder: MIGRATIONS });
  db.insert(schema.projects)
    .values({
      id: 'p',
      name: 'p',
      dsn: 'https://k@upmetrics.org/p',
      apiKey: 'uk_p',
      platform: 'web',
      retentionDays: 30,
      agentRetentionDays: 90,
      createdAt: NOW,
      updatedAt: NOW,
    })
    .run();
  for (let i = 0; i < 5; i++) {
    db.insert(schema.events)
      .values({ id: `e${i}`, projectId: 'p', kind: 'error', receivedAt: NOW, occurredAt: NOW, payload: {} })
      .run();
  }
  return db;
}

describe('rowsChanged — against a real bun:sqlite database', () => {
  it('a DELETE that hits reports the number of rows it removed', () => {
    const db = freshDb();
    const res = db.delete(schema.events).where(inArray(schema.events.id, ['e0', 'e1'])).run();
    expect(rowsChanged(res)).toBe(2);
  });

  it('a DELETE that hits NOTHING reports 0 — the negative control', () => {
    const db = freshDb();
    const res = db.delete(schema.events).where(inArray(schema.events.id, ['nope'])).run();
    expect(rowsChanged(res)).toBe(0);
  });

  it('an UPDATE reports the number of rows it changed', () => {
    const db = freshDb();
    const res = db.update(schema.events).set({ kind: 'message' }).where(eq(schema.events.projectId, 'p')).run();
    expect(rowsChanged(res)).toBe(5);
  });

  it('returns null — never a guessed 0 — when the answer has no readable count', () => {
    expect(rowsChanged(undefined)).toBeNull();
    expect(rowsChanged(null)).toBeNull();
    expect(rowsChanged(42)).toBeNull();
    expect(rowsChanged({})).toBeNull();
    expect(rowsChanged({ changes: '2' })).toBeNull();
  });
});
