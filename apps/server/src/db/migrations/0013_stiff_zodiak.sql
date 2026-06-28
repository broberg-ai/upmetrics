CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`pair` text NOT NULL,
	`rate` real NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `fx_rates_pair_idx` ON `fx_rates` (`pair`,`fetched_at`);