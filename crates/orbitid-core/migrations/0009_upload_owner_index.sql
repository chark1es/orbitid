-- Index-backed orphan-upload detection.
--
-- The retention worker used to test every candidate with
-- `right(u.image_url, length(file) + 1) = '/' || file`, a per-row expression
-- that cannot use an index, so each tick scanned `users` and `organizations`
-- once per orphaned upload. The final path segment of the stored pointer is
-- now a generated column, indexed, and the sweep compares it with `=`:
--
--   SELECT 1 FROM users u WHERE u.image_file = uploads.file
--
-- `image_file` is derived by Postgres from the pointer, so it can never drift
-- from `image_url`; no write site has to remember to update it.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS image_file TEXT GENERATED ALWAYS AS (
        CASE
            WHEN image_url IS NULL THEN NULL
            WHEN image_url LIKE '%/%' THEN regexp_replace(image_url, '^.*/', '')
            ELSE NULL
        END
    ) STORED;

ALTER TABLE organizations
    ADD COLUMN IF NOT EXISTS image_file TEXT GENERATED ALWAYS AS (
        CASE
            WHEN image_url IS NULL THEN NULL
            WHEN image_url LIKE '%/%' THEN regexp_replace(image_url, '^.*/', '')
            ELSE NULL
        END
    ) STORED;

CREATE INDEX IF NOT EXISTS users_image_file_idx
    ON users (image_file) WHERE image_file IS NOT NULL;
CREATE INDEX IF NOT EXISTS organizations_image_file_idx
    ON organizations (image_file) WHERE image_file IS NOT NULL;

-- Candidate scans for the bounded session-expiry sweep.
CREATE INDEX IF NOT EXISTS sessions_active_expire_idx
    ON sessions (expire_at) WHERE status IN ('active', 'pending');
CREATE INDEX IF NOT EXISTS sessions_active_last_active_idx
    ON sessions (last_active_at) WHERE status IN ('active', 'pending');
