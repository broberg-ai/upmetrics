ALTER TABLE `deploy_events` ADD `regression_verdict` text;--> statement-breakpoint
ALTER TABLE `deploy_events` ADD `evaluated_at` integer;--> statement-breakpoint
ALTER TABLE `deploy_events` ADD `regression_detail` text;