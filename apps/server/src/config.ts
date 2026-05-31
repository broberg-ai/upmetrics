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
  resendApiBase: process.env.RESEND_API_BASE ?? 'https://api.resend.com',
  // Self-monitoring (F009.1 dogfood): the server's own @upmetrics/sdk DSN.
  selfDsn: process.env.UPMETRICS_SELF_DSN ?? '',
  // Probes (F004): cronjobs.webhouse.net is the scheduler/trigger.
  cronjobsApiBase: process.env.CRONJOBS_API_BASE ?? 'https://cronjobs.webhouse.net',
  cronjobsApiToken: process.env.CRONJOBS_API_TOKEN ?? '',
  // Incident correlation (F005.1).
  correlationIntervalMs: int('CORRELATION_INTERVAL_MS', 30_000),
  spikeWindowMs: int('SPIKE_WINDOW_MS', 300_000), // 5 min
  errorSpikeThreshold: int('ERROR_SPIKE_THRESHOLD', 10),
  agentFailureSpikeThreshold: int('AGENT_FAILURE_SPIKE_THRESHOLD', 5),
  // Alert engine (F005.2). Dedup window per (rule, incident, severity).
  alertDedupWindowMs: int('ALERT_DEDUP_WINDOW_MS', 3_600_000), // 1h
  // Remediation dispatcher (F005.3).
  remediationThreshold: process.env.REMEDIATION_THRESHOLD ?? 'medium', // min severity
  remediationRetries: int('REMEDIATION_RETRIES', 3),
  remediationBackoffMs: int('REMEDIATION_BACKOFF_MS', 500),
  // Fleet-scale alert-storm control (F008.3). Layers on top of F005.2 dedup.
  stormWindowMs: int('STORM_WINDOW_MS', 300_000), // 5 min correlation window
  stormProjectThreshold: int('STORM_PROJECT_THRESHOLD', 3), // distinct projects → fleet roll-up
  stormIncidentThreshold: int('STORM_INCIDENT_THRESHOLD', 5), // total open incidents → fleet roll-up
  // Incident kinds that are a "region/upmetrics-down" suppressor signal (AC2):
  // when one is open, downstream per-site alerts are suppressed for the window.
  fleetOutageKinds: (process.env.FLEET_OUTAGE_KINDS ?? 'region_down,upmetrics_down').split(',').filter(Boolean),
  fleetAlertDiscordWebhook: process.env.FLEET_ALERT_DISCORD_WEBHOOK ?? '', // roll-up + digest target
  alertRateCapacity: int('ALERT_RATE_CAPACITY', 10), // global token bucket per window
  alertDigestIntervalMs: int('ALERT_DIGEST_INTERVAL_MS', 600_000), // 10 min min between digests
  // Ops hardening (F007).
  retentionIntervalMs: int('RETENTION_INTERVAL_MS', 86_400_000), // daily compaction
  retentionBatchSize: int('RETENTION_BATCH_SIZE', 1000), // batched deletes (no long lock)
  probeCompactionDays: int('PROBE_COMPACTION_DAYS', 7), // downsample probe_results to hourly after
  ingestWarnIntervalMs: int('INGEST_WARN_INTERVAL_MS', 60_000), // dedup the over-limit warning event
  // Auto-remediation relay (F010). Buddy (local) polls /api/remediation/pending
  // with this bearer token + claims relayed incidents. Pull model — upmetrics
  // never pushes (Buddy is Tailscale-local, not cloud-reachable).
  remediationRelayToken: process.env.REMEDIATION_RELAY_TOKEN ?? '',
  remediationRelaySeverity: process.env.REMEDIATION_RELAY_SEVERITY ?? 'high', // min severity to relay
  remediationEscalateMs: int('REMEDIATION_ESCALATE_MS', 1_800_000), // unclaimed > this → escalate to Christian
} as const;

// Fail fast in production with a CLEAR error if a required secret is missing or
// still the dev default — never silently ship with insecure defaults.
if (config.nodeEnv === 'production') {
  const missing: string[] = [];
  if (!config.authSecret || config.authSecret === 'dev-only-secret-change-in-prod') missing.push('AUTH_SECRET');
  if (!config.resendApiKey) missing.push('RESEND_API_KEY');
  if (missing.length) {
    throw new Error(`Missing required production env: ${missing.join(', ')} — set via fly secrets before deploy.`);
  }
}

export type Config = typeof config;
