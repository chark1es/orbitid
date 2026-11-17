ALTER TABLE "clients" ADD COLUMN "token_issued_at" bigint;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "consumed_at" bigint;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "successor_id" text;