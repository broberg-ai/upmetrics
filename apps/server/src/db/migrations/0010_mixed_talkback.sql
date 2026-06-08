CREATE TABLE `deploy_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`site` text NOT NULL,
	`deploy_id` text,
	`provider` text,
	`status` text NOT NULL,
	`sha` text,
	`version` text,
	`originator` text,
	`relayed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deploy_events_project_idx` ON `deploy_events` (`project_id`);--> statement-breakpoint
CREATE INDEX `deploy_events_site_idx` ON `deploy_events` (`site`);--> statement-breakpoint
CREATE UNIQUE INDEX `deploy_events_deploy_idx` ON `deploy_events` (`project_id`,`deploy_id`);