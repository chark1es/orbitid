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
