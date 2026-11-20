-- Dashboard sessions belong to a signed-in account; the secret key no longer
-- opens the dashboard.
--
-- `user_id` is the account that holds an instance role with
-- `app:sys_dashboard:access`; `session_id` is that account's own session on
-- this browser. Every request re-checks that the account still has console
-- access and that its session is still active, so revoking the role, banning
-- the account or signing out ends the console session immediately. There is no
-- foreign key on purpose: the check treats a deleted user or session as "no
-- access", and a cascade would make user deletion lock operator rows outside
-- the global lock order.
--
-- Sessions opened with the secret key have no account behind them and end
-- here: their operators sign in with an account that holds the Owner or
-- Administrator role (`orbitid owner <email>` grants it on the server).
ALTER TABLE "operator_sessions" ADD COLUMN IF NOT EXISTS "user_id" text;
ALTER TABLE "operator_sessions" ADD COLUMN IF NOT EXISTS "session_id" text;
DELETE FROM "operator_sessions" WHERE "user_id" IS NULL OR "session_id" IS NULL;
ALTER TABLE "operator_sessions" ALTER COLUMN "user_id" SET NOT NULL;
ALTER TABLE "operator_sessions" ALTER COLUMN "session_id" SET NOT NULL;

-- First-run owner setup is offered once per instance. The row records that the
-- instance has been claimed and is never removed, so deleting every account
-- later does not reopen setup. The first real (non-guest) account claims the
-- instance too (trigger below): setup is for an instance that never had one. An instance that existed before this migration
-- (its settings row exists, or it has accounts) is claimed already: it never
-- offers setup, and its operator grants the Owner role with `orbitid owner`.
-- A fresh database has no settings row yet at this point (the server writes it
-- after migrating), so it stays unclaimed until its owner is created.
CREATE TABLE IF NOT EXISTS "console_owner_setup" (
  "id" text PRIMARY KEY DEFAULT 'default' CHECK ("id" = 'default'),
  "claimed_at" bigint NOT NULL
);
INSERT INTO "console_owner_setup" ("id", "claimed_at")
SELECT 'default', (extract(epoch FROM clock_timestamp()) * 1000)::bigint
WHERE EXISTS (SELECT 1 FROM "instance")
   OR EXISTS (SELECT 1 FROM "users" WHERE NOT "is_anonymous")
ON CONFLICT ("id") DO NOTHING;

-- Claim on the first real account, whichever path creates it (sign-up, the
-- Backend API, a guest upgrading, an import). It writes at most once: after the
-- row exists the trigger only reads it.
CREATE OR REPLACE FUNCTION "orbitid_claim_owner_setup"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "console_owner_setup") THEN
    INSERT INTO "console_owner_setup" ("id", "claimed_at")
    VALUES ('default', (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "users_claim_owner_setup" ON "users";
CREATE TRIGGER "users_claim_owner_setup"
  AFTER INSERT OR UPDATE OF "is_anonymous" ON "users"
  FOR EACH ROW WHEN (NOT NEW."is_anonymous")
  EXECUTE FUNCTION "orbitid_claim_owner_setup"();
