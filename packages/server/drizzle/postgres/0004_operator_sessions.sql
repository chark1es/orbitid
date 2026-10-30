CREATE TABLE "operator_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "operator_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "operator_sessions_expires_idx" ON "operator_sessions" USING btree ("expires_at");