// Apply pending Drizzle migrations to the configured bun:sqlite DB.
// Run with: bun run src/db/migrate.ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { ensureIncrementalAutoVacuum } from './vacuum';

const path = process.env.DATABASE_PATH ?? './local.db';
const sqlite = new Database(path);
sqlite.exec('PRAGMA busy_timeout = 5000;'); // wait out a lock (app/Litestream) instead of failing the boot migration
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
console.log(`migrations applied to ${path}`);

// F025.2 — one-time switch to auto_vacuum=INCREMENTAL so retention can give
// space back. Runs here, before the server listens and before Litestream starts.
// NEVER allowed to fail the boot: start.sh runs under `set -e`, so a throw here
// would restart-loop the machine — an outage traded for disk space. VACUUM is
// transactional, so a failed attempt leaves the database exactly as it was.
try {
  const r = ensureIncrementalAutoVacuum(sqlite);
  console.log('[vacuum]', JSON.stringify(r));
} catch (err) {
  console.error('[vacuum] omlægning til INCREMENTAL fejlede — serveren starter alligevel:', err);
}
