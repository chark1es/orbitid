-- Retention support and upload ownership/idempotency indexes.
--
-- The retention worker (orbitid_identity::retention) deletes bounded batches
-- from audit logs, webhook deliveries/events and orphaned upload rows. Every
-- sweep is ordered and filtered by the columns below, so it stays index-backed
-- instead of scanning a growing table.
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_status_created_at_idx
    ON webhook_deliveries (status, created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_event_id_idx
    ON webhook_deliveries (event_id);
CREATE INDEX IF NOT EXISTS webhook_events_created_at_idx ON webhook_events (created_at);
CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads (created_at);
