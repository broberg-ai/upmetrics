// Apply pending Drizzle migrations to the configured bun:sqlite DB.
// Run with: bun run src/db/migrate.ts
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const path = process.env.DATABASE_PATH ?? './local.db';
const db = drizzle(new Database(path));
migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });
console.log(`migrations applied to ${path}`);
