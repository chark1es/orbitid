-- no-transaction
-- Indexed verified-domain lookups.
--
-- Built CONCURRENTLY (hence the `-- no-transaction` directive above and exactly
-- one statement in this file: a multi-statement simple query is an implicit
-- transaction, which CREATE INDEX CONCURRENTLY refuses). Writes to
-- `email_addresses` are not blocked while an existing large table is indexed.
-- A concurrent build that failed leaves an INVALID index of this name;
-- `db::run_migrations` drops such an index before the migrator runs.
--
-- Verified-domain enrollment and the domain suggestion counts used to select
-- `lower(email) LIKE '%@domain'`, a leading-wildcard pattern that cannot use
-- any index and so scanned every row of `email_addresses` per domain. The
-- domain part is now an expression index, and the queries compare it with `=`:
--
--   WHERE verified = true AND user_id IS NOT NULL
--     AND lower(split_part(email, '@', 2)) = $domain
--
-- The trailing `user_id` makes the keyset page (`user_id > $cursor ORDER BY
-- user_id LIMIT n`) an index range scan with no sort.
CREATE INDEX CONCURRENTLY IF NOT EXISTS email_addresses_verified_domain_idx
    ON email_addresses (lower(split_part(email, '@', 2)), user_id)
    WHERE verified = true AND user_id IS NOT NULL;
