-- no-transaction
-- Grants by application (application deletion cascade, revocation).
--
-- One statement per file, built CONCURRENTLY (see 0010). Registered in
-- `REQUIRED_INDEXES` so startup recreates it if it is missing or INVALID.
-- Without it the revocation paths (`orbitid_identity::grants`) sequentially
-- scan `oauth_grants` while holding locks.
CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_grants_application_idx
    ON oauth_grants (application_id);
