// bun:sqlite + Drizzle client. DATABASE_PATH points at the fly.io volume in prod.
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';
import { eq, isNull, sql } from 'drizzle-orm';

export function createDb(path: string = process.env.DATABASE_PATH ?? './local.db') {
  const sqlite = new Database(path);
  // F025.2 — a NEW database is born able to give freed pages back to the disk.
  // This only takes effect on a database with no tables yet; an existing one is
  // converted once at boot (db/vacuum.ts, run from migrate.ts). Set before WAL
  // so it precedes anything that could write the first page.
  sqlite.exec('PRAGMA auto_vacuum = INCREMENTAL;');
  sqlite.exec('PRAGMA journal_mode = WAL;');
  // Wait up to 5s for a lock to clear instead of throwing "database is locked"
  // immediately — absorbs transient contention from WAL checkpoints + the
  // Litestream replicator + the boot migration connection.
  sqlite.exec('PRAGMA busy_timeout = 5000;');
  // Safe + faster with WAL (durable via the WAL + Litestream); shorter commit
  // fsyncs → shorter lock windows → less contention.
  sqlite.exec('PRAGMA synchronous = NORMAL;');
  // Hand WAL checkpointing to Litestream; the app NEVER runs an inline
  // checkpoint. bun:sqlite is synchronous on a single event loop, so a
  // writer-triggered checkpoint that stalls on slow disk / a backed-up
  // Litestream→S3 sync freezes EVERY request (incl. /health) → fly drops the
  // instance from tcp/443 → flapping outage (2026-06-02; see docs/adr/0001).
  // With autocheckpoint off, app writes only append to the WAL (fast) and stay
  // responsive even while Litestream is catching up to slow Tigris; durability
  // degrades gracefully (WAL grows, RPO rises) instead of the event loop
  // freezing. Litestream owns checkpoint + truncation on its own schedule.
  sqlite.exec('PRAGMA wal_autocheckpoint = 0;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  return drizzle(sqlite, { schema });
}

export type Db = ReturnType<typeof createDb>;

// Process-wide singleton for request handlers.
let _db: Db | undefined;
export function getDb(): Db {
  return (_db ??= createDb());
}

export { schema };

/**
 * F031 — give every project a numeric DSN alias, at every boot.
 *
 * The migration backfills the rows that existed when it ran, and the dashboard
 * route assigns one to projects it creates. Neither covers a project inserted
 * BY HAND against the production database — which is how most fleet repos are
 * actually enrolled, including three enrolled the day this shipped. Such a
 * project would have a working slug DSN and a numeric DSN that silently does
 * not exist, and the feature would look shipped.
 *
 * Idempotent and cheap: a no-op the moment every row has one. It exists because
 * a migration runs ONCE and manual inserts keep arriving afterwards.
 */
export function ensureDsnNumericIds(db: ReturnType<typeof getDb>): number {
  const missing = db.select().from(schema.projects).where(isNull(schema.projects.dsnNumericId)).all();
  if (missing.length === 0) return 0;
  const row = db.select({ m: sql<number>`coalesce(max(dsn_numeric_id), 0)` }).from(schema.projects).get();
  let next = (row?.m ?? 0) + 1;
  for (const p of missing) {
    db.update(schema.projects).set({ dsnNumericId: next++ }).where(eq(schema.projects.id, p.id)).run();
  }
  console.log(`[dsn] assigned a numeric alias to ${missing.length} project(s)`);
  return missing.length;
}
