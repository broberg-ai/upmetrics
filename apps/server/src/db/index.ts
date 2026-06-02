// bun:sqlite + Drizzle client. DATABASE_PATH points at the fly.io volume in prod.
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export function createDb(path: string = process.env.DATABASE_PATH ?? './local.db') {
  const sqlite = new Database(path);
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
