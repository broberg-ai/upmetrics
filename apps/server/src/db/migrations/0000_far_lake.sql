CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`parent_run_id` text,
	`agent_kind` text NOT NULL,
	`agent_name` text NOT NULL,
	`task` text NOT NULL,
	`purpose` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`tier` text,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`duration_ms` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`tool_calls` text,
	`artifacts` text,
	`prompt_excerpt` text,
	`response_excerpt` text,
	`error_issue_id` text,
	`tags` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`error_issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_runs_project_idx` ON `agent_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_session_idx` ON `agent_runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_name_idx` ON `agent_runs` (`agent_name`);--> statement-breakpoint
CREATE TABLE `alert_history` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_rule_id` text NOT NULL,
	`fired_at` integer NOT NULL,
	`payload` text,
	`channels_sent` text,
	`errors` text,
	FOREIGN KEY (`alert_rule_id`) REFERENCES `alert_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alert_history_rule_idx` ON `alert_history` (`alert_rule_id`);--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`condition` text,
	`channels` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alert_rules_project_idx` ON `alert_rules` (`project_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`received_at` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`payload` text NOT NULL,
	`issue_id` text,
	`release` text,
	`environment` text,
	`tags` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_project_idx` ON `events` (`project_id`);--> statement-breakpoint
CREATE INDEX `events_issue_idx` ON `events` (`issue_id`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	`trigger_ref` text NOT NULL,
	`remediation_attempts` text,
	`events_at_open` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `incidents_project_idx` ON `incidents` (`project_id`);--> statement-breakpoint
CREATE TABLE `issues` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`culprit` text,
	`status` text DEFAULT 'unresolved' NOT NULL,
	`level` text DEFAULT 'error' NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`event_count` integer DEFAULT 0 NOT NULL,
	`user_count` integer DEFAULT 0 NOT NULL,
	`assignee` text,
	`resolved_in_release` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_fingerprint_idx` ON `issues` (`project_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `probe_results` (
	`id` text PRIMARY KEY NOT NULL,
	`probe_id` text NOT NULL,
	`checked_at` integer NOT NULL,
	`ok` integer NOT NULL,
	`response_ms` integer,
	`status_code` integer,
	`error` text,
	FOREIGN KEY (`probe_id`) REFERENCES `probes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `probe_results_probe_idx` ON `probe_results` (`probe_id`);--> statement-breakpoint
CREATE TABLE `probes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`config` text,
	`interval_seconds` integer NOT NULL,
	`cronjobs_job_id` text,
	`status` text DEFAULT 'paused' NOT NULL,
	`last_check_at` integer,
	`last_response_ms` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `probes_project_idx` ON `probes` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`dsn` text NOT NULL,
	`api_key` text NOT NULL,
	`platform` text NOT NULL,
	`remediation_webhook_url` text,
	`remediation_webhook_secret` text,
	`alert_email` text,
	`alert_discord_webhook` text,
	`retention_days` integer DEFAULT 30 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_dsn_unique` ON `projects` (`dsn`);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_api_key_unique` ON `projects` (`api_key`);