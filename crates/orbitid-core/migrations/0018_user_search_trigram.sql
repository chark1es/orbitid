-- Trigram indexes for the dashboard's user search.
--
-- `GET /v1/users?query=` matches `lower(column) LIKE '%term%'` on the user's
-- id, username, names, email addresses and phone numbers. A leading wildcard
-- cannot use a btree, so every keystroke in the command palette scanned
-- `users`, `email_addresses` and `phone_numbers` in full. pg_trgm GIN indexes
-- serve `LIKE '%term%'` directly for terms of three characters or more.
--
-- pg_trgm ships with Postgres and is a trusted extension (13+), so the
-- database owner can create it without superuser. Where it still cannot be
-- created (a locked-down managed database), this migration logs a notice and
-- skips the indexes: search keeps working, only without the speed-up, and
-- startup is never blocked. Run `CREATE EXTENSION pg_trgm` and re-create the
-- indexes below by hand to enable it later.
--
-- Built inside the migration transaction (not CONCURRENTLY) because whether
-- the indexes can exist depends on the extension step above it. These are
-- small identity tables; the build is a short write lock on each.
DO $$
BEGIN
    BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'pg_trgm is unavailable (%); user search runs without trigram indexes', SQLERRM;
    END;

    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        CREATE INDEX IF NOT EXISTS users_search_id_trgm_idx
            ON users USING gin (lower(id) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS users_search_username_trgm_idx
            ON users USING gin (lower(username) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS users_search_first_name_trgm_idx
            ON users USING gin (lower(first_name) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS users_search_last_name_trgm_idx
            ON users USING gin (lower(last_name) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS users_search_full_name_trgm_idx
            ON users USING gin ((lower(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS email_addresses_search_trgm_idx
            ON email_addresses USING gin (lower(email) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS phone_numbers_search_trgm_idx
            ON phone_numbers USING gin (lower(phone) gin_trgm_ops);
    END IF;
END
$$;
