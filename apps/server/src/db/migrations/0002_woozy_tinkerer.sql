ALTER TABLE `probe_results` ADD `sample_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `agent_retention_days` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `rate_limit_per_min` integer DEFAULT 1200 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `storage_max_events` integer DEFAULT 500000 NOT NULL;