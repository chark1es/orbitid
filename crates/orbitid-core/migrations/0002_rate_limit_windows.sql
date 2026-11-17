-- Rust-only rate limiting bookkeeping. The TypeScript server kept rate-limit
-- counters in one process's memory (and in the `rate_limits` table for the
-- per-process sweep). A multi-replica Rust deployment needs the counter to be
-- shared, so this table is the authoritative fixed-window counter. It is
-- deliberately separate from `rate_limits` so the TypeScript schema and the
-- drizzle-compatible baseline stay untouched.
CREATE TABLE "rate_limit_windows" (
    "key" text PRIMARY KEY NOT NULL,
    "count" bigint NOT NULL,
    "reset_at" bigint NOT NULL
);
CREATE INDEX "rate_limit_windows_reset_idx" ON "rate_limit_windows" ("reset_at");
