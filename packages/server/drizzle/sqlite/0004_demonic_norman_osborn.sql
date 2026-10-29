CREATE TABLE `device_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`application_id` text NOT NULL,
	`device_code_hash` text NOT NULL,
	`user_code` text NOT NULL,
	`scopes` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_id` text,
	`interval_seconds` integer DEFAULT 5 NOT NULL,
	`last_polled_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `oauth_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_device_code_hash_unique` ON `device_codes` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_codes_user_code_unique` ON `device_codes` (`user_code`);--> statement-breakpoint
CREATE TABLE `trusted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`user_agent` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_devices_token_hash_unique` ON `trusted_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `trusted_devices_user_idx` ON `trusted_devices` (`user_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `is_anonymous` integer DEFAULT false NOT NULL;