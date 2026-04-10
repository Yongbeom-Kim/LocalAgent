PRAGMA foreign_keys=OFF;
--> statement-breakpoint
DROP TABLE IF EXISTS `session_bridges`;
--> statement-breakpoint
DROP INDEX IF EXISTS `session_platform_links_platform_external_thread_key_unique`;
--> statement-breakpoint
ALTER TABLE `sessions` RENAME TO `__old_sessions`;
--> statement-breakpoint
CREATE TABLE `sessions` (
  `session_id` text PRIMARY KEY NOT NULL,
  `parent_session_id` text,
  `task_type` text NOT NULL,
  `executor` text,
  `executor_model` text,
  `status` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `fallback_seed_text` text,
  `fallback_origin` text,
  `fallback_title_hint` text,
  FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `sessions` (
  `session_id`, `parent_session_id`, `task_type`, `executor`, `executor_model`, `status`, `created_at_ms`, `updated_at_ms`, `fallback_seed_text`, `fallback_origin`, `fallback_title_hint`
)
SELECT `session_id`, `parent_session_id`, `task_type`, `executor`, `executor_model`, `status`, `created_at_ms`, `updated_at_ms`, `fallback_seed_text`, `fallback_origin`, `fallback_title_hint`
FROM `__old_sessions`;
--> statement-breakpoint
DROP TABLE `__old_sessions`;
--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status_updated_at` ON `sessions` (`status`, `updated_at_ms` DESC);
--> statement-breakpoint
ALTER TABLE `lark_threads` RENAME TO `__old_lark_threads`;
--> statement-breakpoint
CREATE TABLE `lark_threads` (
  `root_message_id` text PRIMARY KEY NOT NULL,
  `thread_id` text,
  `root_session_id` text NOT NULL,
  `source` text NOT NULL,
  `chat_type` text,
  `task_type` text NOT NULL,
  `executor` text NOT NULL,
  `executor_model` text NOT NULL,
  `status` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `lark_threads` (
  `root_message_id`, `thread_id`, `root_session_id`, `source`, `chat_type`, `task_type`, `executor`, `executor_model`, `status`, `created_at_ms`, `updated_at_ms`
)
SELECT `root_message_id`, `thread_id`, `root_session_id`, `source`, `chat_type`, `task_type`, `executor`, `executor_model`, `status`, `created_at_ms`, `updated_at_ms`
FROM `__old_lark_threads`;
--> statement-breakpoint
DROP TABLE `__old_lark_threads`;
--> statement-breakpoint
CREATE UNIQUE INDEX `lark_threads_thread_id_unique` ON `lark_threads` (`thread_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `lark_threads_root_session_id_unique` ON `lark_threads` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_root_session_id` ON `lark_threads` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_thread_id` ON `lark_threads` (`thread_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_status_updated_at` ON `lark_threads` (`status`, `updated_at_ms` DESC);
--> statement-breakpoint
ALTER TABLE `telegram_threads` RENAME TO `__old_telegram_threads`;
--> statement-breakpoint
CREATE TABLE `telegram_threads` (
  `chat_id` text NOT NULL,
  `topic_id` text NOT NULL,
  `root_session_id` text NOT NULL,
  `source` text NOT NULL,
  `task_type` text NOT NULL,
  `executor` text NOT NULL,
  `executor_model` text NOT NULL,
  `status` text NOT NULL,
  `seed_message_id` text,
  `status_message_id` text,
  `metadata_json` text,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  PRIMARY KEY (`chat_id`, `topic_id`)
);
--> statement-breakpoint
INSERT INTO `telegram_threads` (
  `chat_id`, `topic_id`, `root_session_id`, `source`, `task_type`, `executor`, `executor_model`, `status`, `seed_message_id`, `status_message_id`, `metadata_json`, `created_at_ms`, `updated_at_ms`
)
SELECT `chat_id`, `topic_id`, `root_session_id`, `source`, `task_type`, `executor`, `executor_model`, `status`, `seed_message_id`, `status_message_id`, `metadata_json`, `created_at_ms`, `updated_at_ms`
FROM `__old_telegram_threads`;
--> statement-breakpoint
DROP TABLE `__old_telegram_threads`;
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_threads_root_session_id_unique` ON `telegram_threads` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_telegram_threads_root_session_id` ON `telegram_threads` (`root_session_id`);
--> statement-breakpoint
CREATE INDEX `idx_telegram_threads_status_updated_at` ON `telegram_threads` (`status`, `updated_at_ms` DESC);
--> statement-breakpoint
ALTER TABLE `session_platform_links` RENAME TO `__old_session_platform_links`;
--> statement-breakpoint
CREATE TABLE `session_platform_links` (
  `session_id` text NOT NULL,
  `platform` text NOT NULL,
  `external_thread_key` text,
  `claim_token` text,
  `claim_expires_at_ms` integer,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  PRIMARY KEY (`session_id`, `platform`),
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `session_platform_links` (
  `session_id`, `platform`, `external_thread_key`, `claim_token`, `claim_expires_at_ms`, `created_at_ms`, `updated_at_ms`
)
SELECT
  `session_id`,
  `platform`,
  `external_thread_key`,
  CASE WHEN `external_thread_key` IS NULL THEN `claim_token` ELSE NULL END,
  CASE WHEN `external_thread_key` IS NULL THEN `claim_expires_at_ms` ELSE NULL END,
  `created_at_ms`,
  `updated_at_ms`
FROM `__old_session_platform_links`
WHERE `link_status` != 'ended';
--> statement-breakpoint
DROP TABLE `__old_session_platform_links`;
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_platform_external_thread_key` ON `session_platform_links` (`platform`, `external_thread_key`);
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_session_id` ON `session_platform_links` (`session_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
