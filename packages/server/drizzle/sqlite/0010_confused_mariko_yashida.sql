ALTER TABLE `clients` ADD `token_issued_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_grants` ADD `consumed_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_grants` ADD `successor_id` text;