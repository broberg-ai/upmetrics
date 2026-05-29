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
