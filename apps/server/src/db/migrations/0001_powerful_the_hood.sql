CREATE TABLE `maintenance_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`project_id` text,
	`kind` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `maintenance_window_idx` ON `maintenance_windows` (`starts_at`,`ends_at`);