PRAGMA foreign_keys=OFF;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `parent_session_id` text REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action;
--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);
--> statement-breakpoint
ALTER TABLE `lark_threads` RENAME COLUMN `session_id` TO `root_session_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `lark_threads_session_id_unique`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_lark_threads_session_id`;
--> statement-breakpoint
CREATE UNIQUE INDEX `lark_threads_root_session_id_unique` ON `lark_threads` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_root_session_id` ON `lark_threads` (`root_session_id`);
--> statement-breakpoint
ALTER TABLE `telegram_threads` RENAME COLUMN `session_id` TO `root_session_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_telegram_threads_session_id`;
--> statement-breakpoint
CREATE INDEX `idx_telegram_threads_root_session_id` ON `telegram_threads` (`root_session_id`);
--> statement-breakpoint
ALTER TABLE `session_bridges` RENAME COLUMN `session_id` TO `root_session_id`;
--> statement-breakpoint
ALTER TABLE `session_platform_links` RENAME TO `__old_session_platform_links`;
--> statement-breakpoint
CREATE TABLE `session_platform_links` (
  `session_id` text NOT NULL,
  `platform` text NOT NULL,
  `external_thread_key` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `ended_at_ms` integer,
  PRIMARY KEY (`session_id`, `platform`),
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `session_platform_links` (
  `session_id`,
  `platform`,
  `external_thread_key`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
)
SELECT
  `session_id`,
  `platform`,
  `external_thread_key`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `__old_session_platform_links`;
--> statement-breakpoint
DROP TABLE `__old_session_platform_links`;
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_platform_external_thread_key` ON `session_platform_links` (`platform`, `external_thread_key`);
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_session_id` ON `session_platform_links` (`session_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
