CREATE INDEX `agent_runs_project_started_idx` ON `agent_runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `events_project_received_idx` ON `events` (`project_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_project_release_received_idx` ON `events` (`project_id`,`release`,`received_at`);