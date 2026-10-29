CREATE TABLE `operator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operator_sessions_token_hash_unique` ON `operator_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `operator_sessions_expires_idx` ON `operator_sessions` (`expires_at`);