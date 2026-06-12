// Central config — read once from the environment, validated at boot.
// Secrets come from fly secrets (prod) / .env.local (dev); never hardcoded.
function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`env ${name} must be an integer, got "${raw}"`);
  return n;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${raw}"`);
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
  // F019.4 — read-only GitHub token (classic PAT, scope repo) for the CI/deploy
  // watcher: reads GitHub Actions workflow runs across the fleet repos. Empty →
  // the CI watcher is disabled (the dashboard CI route returns a clear notice).
  githubToken: process.env.GITHUB_TOKEN ?? '',
  // F019.10 — watch-only library repos: shown on /ci WITHOUT being enrolled
  // error/cost projects (no dsn/api_key). Pure CI-observability for infra/npm libs
  // that have no runtime (e.g. broberg-ai/ai-sdk, broberg-ai/components). Comma-sep
  // "owner/repo". Single source; override via env. De-duped against project repos.
  watchOnlyRepos: (process.env.WATCH_ONLY_REPOS ?? 'broberg-ai/ai-sdk,broberg-ai/components')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Probes (F004): cronjobs.webhouse.net is the scheduler/trigger.
  cronjobsApiBase: process.env.CRONJOBS_API_BASE ?? 'https://cronjobs.webhouse.net',
  cronjobsApiToken: process.env.CRONJOBS_API_TOKEN ?? '',
  // F019.2 — probe outage escalation ladder: "<consecutiveFailures>:<severity>"
  // comma-separated. A sustained outage raises the open probe_down incident's
  // severity as failures cross each tier (re-alerts via the alert engine).
  probeEscalateTiers: process.env.PROBE_ESCALATE_TIERS ?? '3:high,10:critical',
  // F019.9 — deploy regression detection (deploy↔error correlation). After a
  // success deploy's observation window elapses, compare the project's error rate
  // after the deploy vs a baseline before it; a material rise (or a brand-new
  // issue) → "regressed". Evaluated on the correlation worker tick; observe-only.
  deployRegressionWindowMs: int('DEPLOY_REGRESSION_WINDOW_MS', 900_000), // 15m after-window
  deployRegressionBaselineMs: int('DEPLOY_REGRESSION_BASELINE_MS', 3_600_000), // 60m baseline
  deployRegressionMultiplier: num('DEPLOY_REGRESSION_MULTIPLIER', 3.0), // after-rate ≥ baseline×this → flag
  deployRegressionMinAfter: int('DEPLOY_REGRESSION_MIN_AFTER', 3), // noise floor (min after-errors)
  deployRegressionNewIssueMin: int('DEPLOY_REGRESSION_NEW_ISSUE_MIN', 3), // new fingerprint ≥ this → flag
  deployRegressionMaxAgeMs: int('DEPLOY_REGRESSION_MAX_AGE_MS', 21_600_000), // 6h recency bound
  // Org-level read-only cost token (GET /api/cost/fleet — cross-project per-agent
  // aggregates for buddy's daily fleet-cost digest). Read-only, cost-only, no PII.
  // Empty → the fleet endpoint is disabled (401). Single source: Fly secret.
  fleetReadKey: process.env.FLEET_READ_KEY ?? '',
  // Lens mint secret (F016 — POST /api/lens-session). Bearer-gates minting a
  // short-lived read-only lens session for visual verification (fleet Lens
  // mint-endpoint standard). Empty → the mint endpoint is disabled (401).
  lensMintSecret: process.env.LENS_MINT_SECRET ?? '',
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
  // F019.11 — deploy push-relay. Completes F019.7 (pull-feed): now that buddycloud.cc
  // is cloud-reachable (arn→arn), upmetrics PUSHES the deploy-complete intercom to the
  // originating cc-session instead of waiting for buddy to poll. Token is a per-consumer
  // Fly secret (BUDDY_CLOUD_DISPATCH_TOKEN). Empty → push disabled, the pull-feed remains.
  buddyCloudDispatchUrl: process.env.BUDDY_CLOUD_DISPATCH_URL ?? 'https://buddycloud.cc/api/seti/v1/intercom',
  buddyCloudDispatchToken: process.env.BUDDY_CLOUD_DISPATCH_TOKEN ?? '',
  // Anti-storm recency bound: a deploy-complete ping is only useful immediately, so a
  // terminal deploy older than this is SUPPRESSED (stamped relayed without pinging).
  // Stops a backlog that accumulated while a target was offline from storming the fleet
  // when push resumes — only fresh deploys ping. 30m default; tune via env.
  deployRelayMaxAgeMs: int('DEPLOY_RELAY_MAX_AGE_MS', 1_800_000),
  remediationEscalateMs: int('REMEDIATION_ESCALATE_MS', 1_800_000), // unclaimed > this → escalate to Christian
  // F005.4 — push error-incidents to cardmem's Inbox as triage cards (PUSH model,
  // cardmem F067). Disabled when CARDMEM_INCIDENTS_KEY is unset. Each incident is
  // pushed at most once (incidents.cardmem_pushed_at); cardmem dedups on
  // fingerprint as a backstop. Scope = the listed upmetrics projects (start:
  // cardmem itself — "cardmem as remediation target"). The claim_url is HMAC-signed
  // with REMEDIATION_RELAY_TOKEN so cardmem can claim without holding that token.
  cardmemIncidentsUrl: process.env.CARDMEM_INCIDENTS_URL ?? 'https://services.cardmem.com/api/incidents',
  cardmemIncidentsKey: process.env.CARDMEM_INCIDENTS_KEY ?? '',
  cardmemPushProjects: (process.env.CARDMEM_PUSH_PROJECTS ?? 'cardmem').split(',').filter(Boolean),
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
