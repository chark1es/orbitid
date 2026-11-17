-- Optimistic concurrency for in-flight sign-in/sign-up attempts.
--
-- Every writer of a `sign_ins` or `sign_ups` row now performs a compare-and-
-- swap on this counter instead of an unconditional update, so a stale request
-- (one that read the row before another request advanced it) can never restore
-- an older status/state — in particular it can never turn a completed attempt
-- back into `needs_first_factor`. Terminal rows are immutable.
ALTER TABLE "sign_ins" ADD COLUMN IF NOT EXISTS "version" bigint NOT NULL DEFAULT 0;
ALTER TABLE "sign_ups" ADD COLUMN IF NOT EXISTS "version" bigint NOT NULL DEFAULT 0;
