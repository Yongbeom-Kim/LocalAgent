CREATE TABLE `telegram_threads` (
  `chat_id` text NOT NULL,
  `topic_id` text NOT NULL,
  `session_id` text NOT NULL UNIQUE,
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
  `ended_at_ms` integer,
  PRIMARY KEY (`chat_id`, `topic_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_threads_session_id` ON `telegram_threads` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_telegram_threads_status_updated_at` ON `telegram_threads` (`status`, `updated_at_ms` DESC);
--> statement-breakpoint
CREATE TABLE `telegram_messages` (
  `chat_id` text NOT NULL,
  `message_id` text NOT NULL,
  `topic_id` text NOT NULL,
  `session_id` text NOT NULL,
  `direction` text NOT NULL,
  `sender_type` text NOT NULL,
  `message_type` text NOT NULL,
  `raw_content` text NOT NULL,
  `normalized_text` text,
  `metadata_json` text,
  `created_at_ms` integer NOT NULL,
  PRIMARY KEY (`chat_id`, `message_id`),
  FOREIGN KEY (`chat_id`, `topic_id`) REFERENCES `telegram_threads`(`chat_id`, `topic_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_telegram_messages_topic_created_at` ON `telegram_messages` (`chat_id`, `topic_id`, `created_at_ms`, `message_id`);
--> statement-breakpoint
CREATE INDEX `idx_telegram_messages_session_created_at` ON `telegram_messages` (`session_id`, `created_at_ms`, `message_id`);
--> statement-breakpoint
CREATE TABLE `session_bridges` (
  `session_id` text PRIMARY KEY NOT NULL,
  `lark_root_message_id` text NOT NULL UNIQUE,
  `telegram_chat_id` text NOT NULL,
  `telegram_topic_id` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `ended_at_ms` integer,
  FOREIGN KEY (`lark_root_message_id`) REFERENCES `lark_threads`(`root_message_id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`telegram_chat_id`, `telegram_topic_id`) REFERENCES `telegram_threads`(`chat_id`, `topic_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_bridges_telegram_topic_unique` ON `session_bridges` (`telegram_chat_id`, `telegram_topic_id`);
