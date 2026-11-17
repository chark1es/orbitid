-- Bounded retry policy for a domain whose enrollment chunk keeps failing.
--
-- A deterministic failure (for example a failing webhook outbox insert) used to
-- fail the chunk and retry the domain on every tick with only a log line. The
-- worker now counts consecutive failures on the marker row, records the last
-- error and does not attempt the domain again before `enrollment_next_attempt_at`
-- (exponential back-off, capped at one hour). A successful chunk clears all
-- three; the marker itself, and every membership, is never discarded.
ALTER TABLE organization_domains
    ADD COLUMN enrollment_failures integer,
    ADD COLUMN enrollment_last_error text,
    ADD COLUMN enrollment_next_attempt_at bigint;
