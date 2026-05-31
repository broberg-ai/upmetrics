ALTER TABLE `incidents` ADD `relay_claimed_at` integer;--> statement-breakpoint
ALTER TABLE `incidents` ADD `relay_session` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `repo` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `remediation_relay` integer DEFAULT false NOT NULL;