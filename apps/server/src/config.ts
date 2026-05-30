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
  // Auth (F001.4). Secrets come from .env.local (dev) / fly secrets (prod).
  authBaseUrl: process.env.AUTH_BASE_URL ?? `http://localhost:${int('PORT', 3017)}`,
  authSecret: process.env.AUTH_SECRET ?? 'dev-only-secret-change-in-prod',
  authEmailFrom: process.env.AUTH_EMAIL_FROM ?? 'Upmetrics <upmetrics@webhouse.dk>',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  // Probes (F004): cronjobs.webhouse.net is the scheduler/trigger.
  cronjobsApiBase: process.env.CRONJOBS_API_BASE ?? 'https://cronjobs.webhouse.net',
  cronjobsApiToken: process.env.CRONJOBS_API_TOKEN ?? '',
} as const;

export type Config = typeof config;
