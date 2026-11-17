ALTER TABLE "oauth_grants" ADD COLUMN "family_id" text;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "oauth_grants_family_idx" ON "oauth_grants" USING btree ("family_id");--> statement-breakpoint
UPDATE "oauth_grants" SET "family_id" = "nonce", "nonce" = NULL WHERE "kind" IN ('access', 'refresh');