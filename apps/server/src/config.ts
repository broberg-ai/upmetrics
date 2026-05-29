// Central config — read once from the environment, validated at boot.
// Secrets come from fly secrets (prod) / .env.local (dev); never hardcoded.
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`env ${name} must be an integer, got "${raw}"`);
  return n;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: int('PORT', 3017),
  databasePath: process.env.DATABASE_PATH ?? './local.db',
} as const;

export type Config = typeof config;
