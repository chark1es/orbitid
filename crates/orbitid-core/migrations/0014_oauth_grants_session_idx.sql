-- no-transaction
-- Grants by session (session end, under the client lock).
--
-- One statement per file, built CONCURRENTLY (see 0010). Registered in
-- `REQUIRED_INDEXES` so startup recreates it if it is missing or INVALID.
-- Without it the revocation paths (`orbitid_identity::grants`) sequentially
-- scan `oauth_grants` while holding locks.
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_grants_session_idx
    ON oauth_grants (session_id) WHERE session_id IS NOT NULL;
