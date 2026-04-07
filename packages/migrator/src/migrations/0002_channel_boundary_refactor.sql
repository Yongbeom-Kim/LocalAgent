CREATE TABLE `sessions` (
  `session_id` text PRIMARY KEY NOT NULL,
  `task_type` text NOT NULL,
  `executor` text,
  `executor_model` text,
  `status` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `ended_at_ms` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status_updated_at` ON `sessions` (`status`, `updated_at_ms` DESC);
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
CREATE UNIQUE INDEX `session_platform_links_platform_external_thread_key_unique` ON `session_platform_links` (`platform`, `external_thread_key`);
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_session_id` ON `session_platform_links` (`session_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `sessions` (
  `session_id`,
  `task_type`,
  `executor`,
  `executor_model`,
  `status`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
)
SELECT
  `session_id`,
  `task_type`,
  `executor`,
  `executor_model`,
  `status`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `lark_threads`;
--> statement-breakpoint
INSERT INTO `sessions` (
  `session_id`,
  `task_type`,
  `executor`,
  `executor_model`,
  `status`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
)
SELECT
  `session_id`,
  `task_type`,
  `executor`,
  `executor_model`,
  `status`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `telegram_threads`
WHERE 1 = 1
ON CONFLICT(`session_id`) DO UPDATE SET
  `updated_at_ms` = CASE
    WHEN excluded.`updated_at_ms` > `sessions`.`updated_at_ms` THEN excluded.`updated_at_ms`
    ELSE `sessions`.`updated_at_ms`
  END,
  `ended_at_ms` = CASE
    WHEN excluded.`ended_at_ms` IS NULL THEN `sessions`.`ended_at_ms`
    WHEN `sessions`.`ended_at_ms` IS NULL THEN excluded.`ended_at_ms`
    WHEN excluded.`ended_at_ms` > `sessions`.`ended_at_ms` THEN excluded.`ended_at_ms`
    ELSE `sessions`.`ended_at_ms`
  END,
  `task_type` = CASE
    WHEN excluded.`updated_at_ms` >= `sessions`.`updated_at_ms` THEN excluded.`task_type`
    ELSE `sessions`.`task_type`
  END,
  `executor` = CASE
    WHEN excluded.`updated_at_ms` >= `sessions`.`updated_at_ms` THEN excluded.`executor`
    ELSE `sessions`.`executor`
  END,
  `executor_model` = CASE
    WHEN excluded.`updated_at_ms` >= `sessions`.`updated_at_ms` THEN excluded.`executor_model`
    ELSE `sessions`.`executor_model`
  END,
  `status` = CASE
    WHEN excluded.`updated_at_ms` >= `sessions`.`updated_at_ms` THEN excluded.`status`
    ELSE `sessions`.`status`
  END,
  `created_at_ms` = CASE
    WHEN excluded.`created_at_ms` < `sessions`.`created_at_ms` THEN excluded.`created_at_ms`
    ELSE `sessions`.`created_at_ms`
  END;
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
  'lark',
  `root_message_id`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `lark_threads`
WHERE 1 = 1
ON CONFLICT(`session_id`, `platform`) DO UPDATE SET
  `external_thread_key` = excluded.`external_thread_key`,
  `updated_at_ms` = CASE
    WHEN excluded.`updated_at_ms` > `session_platform_links`.`updated_at_ms` THEN excluded.`updated_at_ms`
    ELSE `session_platform_links`.`updated_at_ms`
  END,
  `ended_at_ms` = CASE
    WHEN excluded.`ended_at_ms` IS NULL THEN `session_platform_links`.`ended_at_ms`
    WHEN `session_platform_links`.`ended_at_ms` IS NULL THEN excluded.`ended_at_ms`
    WHEN excluded.`ended_at_ms` > `session_platform_links`.`ended_at_ms` THEN excluded.`ended_at_ms`
    ELSE `session_platform_links`.`ended_at_ms`
  END;
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
  'telegram',
  `telegram_chat_id` || ':' || `telegram_topic_id`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `session_bridges`
WHERE 1 = 1
ON CONFLICT(`session_id`, `platform`) DO UPDATE SET
  `external_thread_key` = excluded.`external_thread_key`,
  `updated_at_ms` = CASE
    WHEN excluded.`updated_at_ms` > `session_platform_links`.`updated_at_ms` THEN excluded.`updated_at_ms`
    ELSE `session_platform_links`.`updated_at_ms`
  END,
  `ended_at_ms` = CASE
    WHEN excluded.`ended_at_ms` IS NULL THEN `session_platform_links`.`ended_at_ms`
    WHEN `session_platform_links`.`ended_at_ms` IS NULL THEN excluded.`ended_at_ms`
    WHEN excluded.`ended_at_ms` > `session_platform_links`.`ended_at_ms` THEN excluded.`ended_at_ms`
    ELSE `session_platform_links`.`ended_at_ms`
  END;
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
  'telegram',
  `chat_id` || ':' || `topic_id`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `telegram_threads`
WHERE 1 = 1
ON CONFLICT(`session_id`, `platform`) DO UPDATE SET
  `external_thread_key` = excluded.`external_thread_key`,
  `updated_at_ms` = CASE
    WHEN excluded.`updated_at_ms` > `session_platform_links`.`updated_at_ms` THEN excluded.`updated_at_ms`
    ELSE `session_platform_links`.`updated_at_ms`
  END,
  `ended_at_ms` = CASE
    WHEN excluded.`ended_at_ms` IS NULL THEN `session_platform_links`.`ended_at_ms`
    WHEN `session_platform_links`.`ended_at_ms` IS NULL THEN excluded.`ended_at_ms`
    WHEN excluded.`ended_at_ms` > `session_platform_links`.`ended_at_ms` THEN excluded.`ended_at_ms`
    ELSE `session_platform_links`.`ended_at_ms`
  END;
