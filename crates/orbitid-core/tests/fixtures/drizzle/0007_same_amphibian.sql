ALTER TABLE "oauth_applications" ALTER COLUMN "pkce_required" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "post_logout_redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "access_token_lifetime_seconds" bigint DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "refresh_token_lifetime_seconds" bigint DEFAULT 2592000 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "id_token_lifetime_seconds" bigint DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "groups_claim" text DEFAULT 'all' NOT NULL;