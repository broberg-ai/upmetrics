// bun:sqlite + Drizzle client. DATABASE_PATH points at the fly.io volume in prod.
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema';

export function createDb(path: string = process.env.DATABASE_PATH ?? './local.db') {
  const sqlite = new Database(path);
  sqlite.exec('PRAGMA journal_mode = WAL;');
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
