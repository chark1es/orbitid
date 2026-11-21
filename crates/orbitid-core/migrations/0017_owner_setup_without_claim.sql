-- Owner setup follows the instance's current state instead of a permanent claim.
--
-- The dashboard offers "Create the owner account" whenever no account can open
-- the console and the instance has no real (non-guest) account. An instance
-- whose accounts were all deleted, or that existed before owners but never had
-- an account, can be set up from the dashboard again. An instance with accounts
-- but no owner still grants the Owner role from the server
-- (`orbitid owner <email>`), so a visitor can never promote themselves over
-- existing users.
--
-- Concurrent setups (and imports) still serialize on the
-- `orbitid_owner_setup` advisory lock; nothing else needs the claim row.
DROP TRIGGER IF EXISTS "users_claim_owner_setup" ON "users";
DROP FUNCTION IF EXISTS "orbitid_claim_owner_setup"();
DROP TABLE IF EXISTS "console_owner_setup";
