// Guest-account cleanup: anonymous users idle longer than `settings.anonymous.retentionSeconds` are deleted.
import { and, eq, lt } from "drizzle-orm";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { onUserDeleted } from "./orgs";
import { emitEvent } from "./webhooks";

/** Rows deleted per tick: a large backlog is worked off over several ticks instead of one huge transaction. */
export const ANONYMOUS_CLEANUP_BATCH = 100;
export const ANONYMOUS_CLEANUP_INTERVAL_MS = 5 * 60_000;

/** Conditions that identify a user as a stale guest; shared by the read and the atomic delete. */
const staleAnonymous = (ctx: AppContext, cutoff: number) => and(
  eq(s.users.isAnonymous, true),
  lt(s.users.lastActiveAt, cutoff),
);

/**
 * Deletes one batch of stale anonymous users. `retentionSeconds === 0` keeps them forever.
 * Each row is removed with a conditional `DELETE … RETURNING`, so a user who upgraded or was active
 * between the read and the delete is never touched. Returns the number of users deleted.
 */
export async function cleanupAnonymousUsers(ctx: AppContext, opts: { now?: number; limit?: number } = {}): Promise<number> {
  const retentionSeconds = ctx.settings.get().anonymous.retentionSeconds;
  if (retentionSeconds <= 0) return 0;
  const cutoff = (opts.now ?? Date.now()) - retentionSeconds * 1000;
  const candidates = await ctx.db.select({ id: s.users.id })
    .from(s.users)
    .where(staleAnonymous(ctx, cutoff))
    .limit(opts.limit ?? ANONYMOUS_CLEANUP_BATCH);
  let deleted = 0;
  for (const candidate of candidates) {
    const claimed = await ctx.db.delete(s.users)
      .where(and(eq(s.users.id, candidate.id), staleAnonymous(ctx, cutoff)))
      .returning({ id: s.users.id });
    if (!claimed.length) continue;
    await emitEvent(ctx, "user.deleted", { object: "user", id: candidate.id, deleted: true });
    await onUserDeleted(ctx, candidate.id);
    deleted += 1;
  }
  return deleted;
}

/** Starts the periodic cleanup (same shape as `startWebhookWorker`). */
export function startAnonymousCleanupWorker(ctx: AppContext, intervalMs = ANONYMOUS_CLEANUP_INTERVAL_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await cleanupAnonymousUsers(ctx);
    } catch (err) {
      console.error("[anonymous] cleanup tick failed", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Ids of anonymous users that would be deleted now (tests/inspection only). */
export async function staleAnonymousUserIds(ctx: AppContext, now = Date.now()): Promise<string[]> {
  const retentionSeconds = ctx.settings.get().anonymous.retentionSeconds;
  if (retentionSeconds <= 0) return [];
  const rows = await ctx.db.select({ id: s.users.id })
    .from(s.users)
    .where(staleAnonymous(ctx, now - retentionSeconds * 1000))
    .limit(ANONYMOUS_CLEANUP_BATCH);
  return rows.map((row) => row.id);
}
