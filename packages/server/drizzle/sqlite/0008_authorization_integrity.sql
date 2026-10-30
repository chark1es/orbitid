DELETE FROM "user_roles" WHERE "role_key" NOT IN (SELECT "key" FROM "roles");
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_roles` (
	`user_id` text NOT NULL,
	`role_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `role_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_key`) REFERENCES `roles`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_user_roles`("user_id", "role_key", "created_at", "updated_at") SELECT "user_id", "role_key", "created_at", "updated_at" FROM `user_roles`;--> statement-breakpoint
DROP TABLE `user_roles`;--> statement-breakpoint
ALTER TABLE `__new_user_roles` RENAME TO `user_roles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ur_role_idx` ON `user_roles` (`role_key`);
