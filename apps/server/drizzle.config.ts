import { defineConfig } from 'drizzle-kit';

// DATABASE_PATH is the bun:sqlite file (a fly.io volume path in prod, local file in dev).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './local.db',
  },
});
