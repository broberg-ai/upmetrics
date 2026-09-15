ALTER TABLE `projects` ADD `dsn_numeric_id` integer;--> statement-breakpoint
-- F031 — backfill every EXISTING project. Without this the column is NULL on a
-- live database and only projects created afterwards get the numeric form: the
-- feature would look shipped and be missing for everyone who was already here.
UPDATE `projects` SET `dsn_numeric_id` = `rowid` WHERE `dsn_numeric_id` IS NULL;--> statement-breakpoint
-- Unique so one project can never answer for another's DSN. NULLs are distinct
-- in SQLite, so this does not block a row that has not been assigned yet.
CREATE UNIQUE INDEX `projects_dsn_numeric_uidx` ON `projects` (`dsn_numeric_id`);
