DROP INDEX `email_unique_verified`;--> statement-breakpoint
CREATE UNIQUE INDEX `email_unique_verified` ON `email_addresses` (`email`) WHERE "email_addresses"."verified" = true;--> statement-breakpoint
DROP INDEX `phone_unique_verified`;--> statement-breakpoint
CREATE UNIQUE INDEX `phone_unique_verified` ON `phone_numbers` (`phone`) WHERE "phone_numbers"."verified" = true;