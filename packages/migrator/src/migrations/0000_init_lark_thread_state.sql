CREATE TABLE `__schema_version` (
  `id` integer PRIMARY KEY NOT NULL,
  `version` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lark_threads` (
  `root_message_id` text PRIMARY KEY NOT NULL,
  `thread_id` text,
  `session_id` text NOT NULL,
  `source` text NOT NULL,
  `chat_type` text,
  `task_type` text NOT NULL,
  `executor` text NOT NULL,
  `executor_model` text NOT NULL,
  `status` text NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `ended_at_ms` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lark_threads_thread_id_unique` ON `lark_threads` (`thread_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `lark_threads_session_id_unique` ON `lark_threads` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_session_id` ON `lark_threads` (`session_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_thread_id` ON `lark_threads` (`thread_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_threads_status_updated_at` ON `lark_threads` (`status`, `updated_at_ms` DESC);
--> statement-breakpoint
CREATE TABLE `lark_messages` (
  `message_id` text PRIMARY KEY NOT NULL,
  `source` text NOT NULL,
  `root_message_id` text NOT NULL,
  `session_id` text NOT NULL,
  `thread_id` text,
  `direction` text NOT NULL,
  `sender_type` text NOT NULL,
  `message_type` text NOT NULL,
  `raw_content` text NOT NULL,
  `normalized_text` text,
  `metadata_json` text,
  `created_at_ms` integer NOT NULL,
  FOREIGN KEY (`root_message_id`) REFERENCES `lark_threads`(`root_message_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_lark_messages_thread_created_at` ON `lark_messages` (`root_message_id`, `created_at_ms`, `message_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_messages_session_created_at` ON `lark_messages` (`session_id`, `created_at_ms`, `message_id`);
--> statement-breakpoint
CREATE INDEX `idx_lark_messages_thread_message_id` ON `lark_messages` (`root_message_id`, `message_id`);

