CREATE TABLE `credit_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`total_credits` real NOT NULL,
	`total_usage` real NOT NULL,
	`remaining` real NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`captured_at` integer NOT NULL,
	`raw` text
);
--> statement-breakpoint
CREATE INDEX `credit_snapshots_provider_idx` ON `credit_snapshots` (`provider`,`captured_at`);