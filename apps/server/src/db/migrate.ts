// Apply pending Drizzle migrations to the configured bun:sqlite DB.
// Run with: bun run src/db/migrate.ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const path = process.env.DATABASE_PATH ?? './local.db';
const sqlite = new Database(path);
sqlite.exec('PRAGMA busy_timeout = 5000;'); // wait out a lock (app/Litestream) instead of failing the boot migration
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
console.log(`migrations applied to ${path}`);
