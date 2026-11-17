ALTER TABLE "oauth_grants" ADD COLUMN "successor_token_enc" text;--> statement-breakpoint
-- Scope allowlists are enforced from this release on. Existing applications effectively used every base scope
-- (the provider allowed them regardless of `scopes`), so keep their behaviour by recording those scopes explicitly.
-- Custom scopes already stored are preserved; duplicate entries are harmless (`parseScopes` dedupes).
UPDATE "oauth_applications" SET "scopes" = "scopes" || ' openid profile email phone groups organizations offline_access';
