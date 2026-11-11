-- Add the OAuth application columns without rebuilding `oauth_applications`.
--
-- Drizzle used to generate a CREATE/INSERT/DROP/RENAME table rebuild here. The migrator runs every migration in a
-- transaction, and SQLite ignores `PRAGMA foreign_keys=OFF` inside one, so `DROP TABLE oauth_applications` cascaded
-- into `oauth_grants`, `oauth_consents` and every other referencing table: upgrading wiped existing grants and
-- consent. None of these columns changes a constraint, so plain ADD COLUMN is equivalent and never drops a table.
ALTER TABLE `oauth_applications` ADD `post_logout_redirect_uris` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_applications` ADD `access_token_lifetime_seconds` integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_applications` ADD `refresh_token_lifetime_seconds` integer DEFAULT 2592000 NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_applications` ADD `id_token_lifetime_seconds` integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE `oauth_applications` ADD `groups_claim` text DEFAULT 'all' NOT NULL;
