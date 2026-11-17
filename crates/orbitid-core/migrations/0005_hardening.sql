-- Hardening indexes and replay protection.
--
-- Additive only: existing migrations are never edited.

-- TOTP replay protection: the last accepted time step (unix time / 30s) for
-- this user's authenticator. A code is only accepted when its matched step is
-- strictly greater than this value.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_last_used_step" bigint;

-- The signed-in user's pending invitations are looked up by verified email.
-- Case-insensitive and partial: only pending rows are ever listed.
CREATE INDEX IF NOT EXISTS "oi_pending_lower_email_created_idx"
    ON "organization_invitations" USING btree (lower("email"), "created_at" DESC)
    WHERE "status" = 'pending';

-- `get_verification`: newest row for one owner+purpose (and optionally one
-- identifier). Matches the exact query shape, including the DESC ordering.
CREATE INDEX IF NOT EXISTS "ver_owner_purpose_identifier_created_idx"
    ON "verifications" USING btree ("owner_id", "purpose", "identifier", "created_at" DESC);

-- `latest_transferable_sign_in` and `inflight_sign_in`: newest sign-in for a
-- client.
CREATE INDEX IF NOT EXISTS "sign_ins_client_created_idx"
    ON "sign_ins" USING btree ("client_id", "created_at" DESC);

-- Retention worker scans.
CREATE INDEX IF NOT EXISTS "ver_expires_at_idx"
    ON "verifications" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "oauth_grants_expires_at_idx"
    ON "oauth_grants" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "device_codes_expires_at_idx"
    ON "device_codes" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "oauth_states_expires_at_idx"
    ON "oauth_states" USING btree ("expires_at");
CREATE INDEX IF NOT EXISTS "sign_ins_abandon_at_idx"
    ON "sign_ins" USING btree ("abandon_at");
CREATE INDEX IF NOT EXISTS "sign_ups_abandon_at_idx"
    ON "sign_ups" USING btree ("abandon_at");
