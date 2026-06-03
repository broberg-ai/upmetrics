// Drizzle schema — mirrors docs/UPMETRICS-PLAN.md §5 (Data Model).
// SQLite (bun:sqlite). JSON columns use text({ mode: 'json' }); timestamps are
// epoch-ms integers; booleans use integer({ mode: 'boolean' }).
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ── projects ──────────────────────────────────────────────────────────────
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(), // slug, e.g. "trail"
  name: text('name').notNull(),
  dsn: text('dsn').notNull().unique(),
  apiKey: text('api_key').notNull().unique(),
  platform: text('platform').notNull(), // web | node | capacitor | native
  remediationWebhookUrl: text('remediation_webhook_url'),
  remediationWebhookSecret: text('remediation_webhook_secret'),
  alertEmail: text('alert_email'),
  alertDiscordWebhook: text('alert_discord_webhook'),
  retentionDays: integer('retention_days').notNull().default(30),
  // F007.1 — agent_runs kept longer than events (analytics value).
  agentRetentionDays: integer('agent_retention_days').notNull().default(90),
  // F007.2 — per-project ingest guardrails (read live, no redeploy needed).
  rateLimitPerMin: integer('rate_limit_per_min').notNull().default(1200),
  storageMaxEvents: integer('storage_max_events').notNull().default(500000),
  // F010 — auto-remediation relay. repo = the repo basename Buddy maps to a cc
  // session; remediation_relay opts the project into the pull-feed.
  repo: text('repo'), // e.g. "cardmem", "fysiodk-aalborg-sport"
  // F006.3 — full "owner/repo" slug for the "Create GitHub issue" deep-link on
  // an issue (distinct from `repo`, which is just the basename Buddy routes on).
  githubRepo: text('github_repo'), // e.g. "broberg-ai/upmetrics"
  remediationRelay: integer('remediation_relay', { mode: 'boolean' }).notNull().default(false),
  // F010.5 — per-project override of the global REMEDIATION_RELAY_SEVERITY gate
  // (null → fall back to config.remediationRelaySeverity). Set self-service via
  // /api/remediation/enrollment (project key) or the dashboard settings card.
  remediationRelaySeverity: text('remediation_relay_severity'), // null | low | medium | high | critical
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// ── events (raw event log, append-only) ─────────────────────────────────────
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(), // event_id from envelope
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(), // error | message | agent_run | probe_result
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    issueId: text('issue_id').references(() => issues.id),
    release: text('release'),
    environment: text('environment'),
    tags: text('tags', { mode: 'json' }),
  },
  (t) => [index('events_project_idx').on(t.projectId), index('events_issue_idx').on(t.issueId)],
);

// ── issues (deduplicated error groups) ──────────────────────────────────────
export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    fingerprint: text('fingerprint').notNull(),
    title: text('title').notNull(),
    culprit: text('culprit'),
    status: text('status').notNull().default('unresolved'), // unresolved | resolved | ignored
    level: text('level').notNull().default('error'), // error | warning | info
    firstSeen: integer('first_seen', { mode: 'timestamp_ms' }).notNull(),
    lastSeen: integer('last_seen', { mode: 'timestamp_ms' }).notNull(),
    eventCount: integer('event_count').notNull().default(0),
    userCount: integer('user_count').notNull().default(0),
    assignee: text('assignee'),
    resolvedInRelease: text('resolved_in_release'),
  },
  (t) => [uniqueIndex('issues_fingerprint_idx').on(t.projectId, t.fingerprint)],
);

// ── agent_runs (specialized AI agent telemetry) ─────────────────────────────
export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    schemaVersion: integer('schema_version').notNull().default(1),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    sessionId: text('session_id'),
    parentRunId: text('parent_run_id'),
    agentKind: text('agent_kind').notNull(), // cc | subagent | chatbot | rag | embedding
    agentName: text('agent_name').notNull(),
    task: text('task').notNull(),
    purpose: text('purpose'), // compliance label (formaal)
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tier: text('tier'), // fast | smart | powerful | embedding
    status: text('status').notNull(), // running | success | error | timeout | max_turns | abandoned
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
    durationMs: integer('duration_ms'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheCreationTokens: integer('cache_creation_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    toolCalls: text('tool_calls', { mode: 'json' }), // [{name, count, error_count}]
    artifacts: text('artifacts', { mode: 'json' }), // [{type, ref}]
    promptExcerpt: text('prompt_excerpt'), // opt-in; null for compliance projects
    responseExcerpt: text('response_excerpt'), // opt-in; null for compliance projects
    errorIssueId: text('error_issue_id').references(() => issues.id),
    tags: text('tags', { mode: 'json' }),
  },
  (t) => [
    index('agent_runs_project_idx').on(t.projectId),
    index('agent_runs_session_idx').on(t.sessionId),
    index('agent_runs_name_idx').on(t.agentName),
  ],
);

// ── probes ──────────────────────────────────────────────────────────────────
export const probes = sqliteTable(
  'probes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // http | tcp | keyword | ssl
    target: text('target').notNull(),
    config: text('config', { mode: 'json' }), // expected_status, keyword, timeout_ms, ...
    intervalSeconds: integer('interval_seconds').notNull(),
    cronjobsJobId: text('cronjobs_job_id'),
    status: text('status').notNull().default('paused'), // up | down | degraded | paused
    lastCheckAt: integer('last_check_at', { mode: 'timestamp_ms' }),
    lastResponseMs: integer('last_response_ms'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (t) => [index('probes_project_idx').on(t.projectId)],
);

// ── probe_results (history, retention-controlled) ───────────────────────────
export const probeResults = sqliteTable(
  'probe_results',
  {
    id: text('id').primaryKey(),
    probeId: text('probe_id')
      .notNull()
      .references(() => probes.id),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }).notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    responseMs: integer('response_ms'),
    statusCode: integer('status_code'),
    error: text('error'),
    // F007.1 — >1 once this row is an hourly downsample of N raw checks (avg responseMs).
    sampleCount: integer('sample_count').notNull().default(1),
  },
  (t) => [index('probe_results_probe_idx').on(t.probeId)],
);

// ── incidents ───────────────────────────────────────────────────────────────
export const incidents = sqliteTable(
  'incidents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(), // probe_down | error_spike | agent_failure_spike
    status: text('status').notNull().default('open'), // open | acknowledged | resolved
    severity: text('severity').notNull(), // critical | high | medium | low
    title: text('title').notNull(),
    openedAt: integer('opened_at', { mode: 'timestamp_ms' }).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
    triggerRef: text('trigger_ref').notNull(), // probe_id, issue_id, or agent metric ref
    remediationAttempts: text('remediation_attempts', { mode: 'json' }), // [{at, webhook_url, response_status, response_body}]
    eventsAtOpen: text('events_at_open', { mode: 'json' }),
    // F010 — auto-remediation relay (pull-feed claim). Set when Buddy relays the
    // incident to a live cc session; claimed incidents drop out of /pending.
    relayClaimedAt: integer('relay_claimed_at', { mode: 'timestamp_ms' }),
    relaySession: text('relay_session'),
    // F010.4 — manual push-to-remediation. Set when a user explicitly pushes an
    // issue/incident to Buddy from the dashboard; bypasses the auto severity +
    // opt-in gates so a single issue can be relayed on demand.
    relayRequestedAt: integer('relay_requested_at', { mode: 'timestamp_ms' }),
    // F005.4 — pushed to cardmem's Inbox as a triage card. Set once after a
    // successful push so each incident becomes at most one card (cardmem also
    // dedups on fingerprint as a backstop). Null = not yet pushed.
    cardmemPushedAt: integer('cardmem_pushed_at', { mode: 'timestamp_ms' }),
    // F010.5 — escalated to the fleet Discord because it stayed unclaimed past
    // REMEDIATION_ESCALATE_MS (no cc session picked it up). Set once → alert at
    // most once per incident. Null = not yet escalated.
    escalationAlertedAt: integer('escalation_alerted_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('incidents_project_idx').on(t.projectId)],
);

// ── alert_rules ─────────────────────────────────────────────────────────────
export const alertRules = sqliteTable(
  'alert_rules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    kind: text('kind').notNull(),
    condition: text('condition', { mode: 'json' }),
    channels: text('channels', { mode: 'json' }), // ["email","discord","webhook"]
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('alert_rules_project_idx').on(t.projectId)],
);

// ── alert_history ───────────────────────────────────────────────────────────
export const alertHistory = sqliteTable(
  'alert_history',
  {
    id: text('id').primaryKey(),
    alertRuleId: text('alert_rule_id')
      .notNull()
      .references(() => alertRules.id),
    firedAt: integer('fired_at', { mode: 'timestamp_ms' }).notNull(),
    payload: text('payload', { mode: 'json' }),
    channelsSent: text('channels_sent', { mode: 'json' }),
    errors: text('errors', { mode: 'json' }),
  },
  (t) => [index('alert_history_rule_idx').on(t.alertRuleId)],
);

// ── maintenance_windows (F008.3) ─────────────────────────────────────────────
// A window silences matching alerts. project_id / kind NULL = wildcard (all).
export const maintenanceWindows = sqliteTable(
  'maintenance_windows',
  {
    id: text('id').primaryKey(),
    reason: text('reason').notNull(),
    projectId: text('project_id'), // null = all projects
    kind: text('kind'), // null = all incident kinds
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('maintenance_window_idx').on(t.startsAt, t.endsAt)],
);
