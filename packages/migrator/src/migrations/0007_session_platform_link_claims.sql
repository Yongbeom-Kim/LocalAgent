PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_session_platform_links` (
  `session_id` text NOT NULL,
  `platform` text NOT NULL,
  `external_thread_key` text,
  `link_status` text NOT NULL,
  `claim_token` text,
  `claim_expires_at_ms` integer,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `ended_at_ms` integer,
  PRIMARY KEY (`session_id`, `platform`),
  FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_session_platform_links` (
  `session_id`,
  `platform`,
  `external_thread_key`,
  `link_status`,
  `claim_token`,
  `claim_expires_at_ms`,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
)
SELECT
  `session_id`,
  `platform`,
  `external_thread_key`,
  CASE WHEN `ended_at_ms` IS NULL THEN 'active' ELSE 'ended' END,
  NULL,
  NULL,
  `created_at_ms`,
  `updated_at_ms`,
  `ended_at_ms`
FROM `session_platform_links`;
--> statement-breakpoint
DROP TABLE `session_platform_links`;
--> statement-breakpoint
ALTER TABLE `__new_session_platform_links` RENAME TO `session_platform_links`;
--> statement-breakpoint
CREATE UNIQUE INDEX `session_platform_links_platform_external_thread_key_unique` ON `session_platform_links` (`platform`, `external_thread_key`) WHERE `external_thread_key` IS NOT NULL AND `link_status` = 'active';
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_platform_external_thread_key` ON `session_platform_links` (`platform`, `external_thread_key`);
--> statement-breakpoint
CREATE INDEX `idx_session_platform_links_session_id` ON `session_platform_links` (`session_id`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
INSERT INTO `__schema_version` (`id`, `version`, `updated_at_ms`, `updated_by`)
VALUES (1, 13, unixepoch() * 1000, '0007_session_platform_link_claims')
ON CONFLICT(`id`) DO UPDATE SET
  `version` = 13,
  `updated_at_ms` = unixepoch() * 1000,
  `updated_by` = '0007_session_platform_link_claims';
