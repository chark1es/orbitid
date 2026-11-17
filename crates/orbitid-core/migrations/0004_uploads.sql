-- Uploaded images (profile avatars and organization logos).
--
-- The TypeScript server wrote these bytes to `<dataDir>/uploads` and
-- `uploads/orgs`, which does not work behind a load balancer: a request served
-- by another replica would 404. The bytes live in Postgres instead so every
-- replica can serve the same public URL (`/v1/client/images/:file` and
-- `/v1/client/organization_logos/:file`).
CREATE TABLE IF NOT EXISTS uploads (
    -- Server-chosen file name (`<owner>_<random>.<ext>`); it is the last path
    -- segment of the public URL.
    file TEXT PRIMARY KEY,
    -- `avatar` | `org_logo`
    bucket TEXT NOT NULL,
    owner_id TEXT,
    content_type TEXT NOT NULL,
    bytes BYTEA NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS uploads_owner_idx ON uploads (bucket, owner_id);
