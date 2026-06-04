ALTER TABLE `agent_runs` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_idem_idx` ON `agent_runs` (`project_id`,`idempotency_key`);