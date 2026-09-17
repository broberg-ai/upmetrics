CREATE TABLE `enroll_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`jti` text,
	`repository` text,
	`repository_id` integer,
	`owner` text,
	`ref` text,
	`sha` text,
	`run_id` text,
	`workflow` text,
	`outcome` text NOT NULL,
	`reason` text,
	`project_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enroll_attempts_jti_unique` ON `enroll_attempts` (`jti`);--> statement-breakpoint
CREATE INDEX `enroll_attempts_at_idx` ON `enroll_attempts` (`at`);--> statement-breakpoint
CREATE INDEX `enroll_attempts_repo_idx` ON `enroll_attempts` (`repository_id`,`at`);--> statement-breakpoint
ALTER TABLE `projects` ADD `enroll_repository` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `enroll_repository_id` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `enrolled_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_enroll_repository_id_unique` ON `projects` (`enroll_repository_id`);