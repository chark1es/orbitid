-- Durable domain enrollment and worker scan progress.
--
-- `enrollment_pending_since` is written in the same transaction as the change
-- that makes automatic enrollment necessary (a domain verified in
-- `automatic_invitation` mode, or switched to it). The reconciliation worker
-- walks the verified-domain index from `enrollment_cursor` (the last user id
-- examined, '' = start), persists the cursor with every committed chunk and
-- clears the marker only when a pass reaches the end.
ALTER TABLE organization_domains
    ADD COLUMN enrollment_pending_since bigint,
    ADD COLUMN enrollment_cursor text NOT NULL DEFAULT '';

CREATE INDEX organization_domains_enrollment_pending_idx
    ON organization_domains (enrollment_pending_since, id)
    WHERE enrollment_pending_since IS NOT NULL;

-- Scan progress of background workers that must make progress across ticks,
-- replicas and restarts (guest cleanup keeps its keyset position here).
CREATE TABLE worker_cursors (
    name text PRIMARY KEY,
    cursor jsonb NOT NULL,
    updated_at bigint NOT NULL
);
