ALTER TABLE `sessions` ADD COLUMN `fallback_seed_text` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `fallback_origin` text;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `fallback_title_hint` text;
