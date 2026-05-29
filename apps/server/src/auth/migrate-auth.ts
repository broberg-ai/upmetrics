// Create/upgrade Better Auth tables in the bun:sqlite DB.
// Runs under Bun (bun:sqlite available); the @better-auth/cli can't read a
// bun:sqlite config under its node loader, so we drive getMigrations directly.
// Run with: bun run src/auth/migrate-auth.ts
import { getMigrations } from 'better-auth/db/migration';
import { auth } from './index';

const { runMigrations } = await getMigrations(auth.options);
await runMigrations();
console.log('better-auth tables migrated');
