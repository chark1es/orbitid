-- Identity hot-path indexes (added by the L2 identity port).
--
-- These back queries that run on every session refresh / client bootstrap and
-- on the invitation list endpoints. They are plain additive indexes; existing
-- migrations are never edited.

-- Active sessions for one client (single-session mode, active-session lookup).
CREATE INDEX IF NOT EXISTS "sess_client_status_idx"
    ON "sessions" USING btree ("client_id", "status");

-- Session serialization looks up the sign-in that created a session (trusted
-- device marker). Partial: most rows have no created session.
CREATE INDEX IF NOT EXISTS "sign_ins_created_session_idx"
    ON "sign_ins" USING btree ("created_session_id")
    WHERE "created_session_id" IS NOT NULL;

-- Duplicate-invitation check and invitation lists scoped to one organization.
CREATE INDEX IF NOT EXISTS "oi_org_status_email_idx"
    ON "organization_invitations" USING btree ("organization_id", "status", "email");

-- Live remembered browsers for one user.
CREATE INDEX IF NOT EXISTS "trusted_devices_live_idx"
    ON "trusted_devices" USING btree ("user_id", "expires_at")
    WHERE "revoked_at" IS NULL;
