// Guest retention is housekeeping, not a sign-out. A guest that still has a live session is never auto-deleted (its
// user row cascades into that session), and retention is opt-in (default 0).
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { cleanupAnonymousUsers, staleAnonymousUserIds } from "../../src/services/anonymous";
import { endSession, getSession } from "../../src/services/sessions";
import { insertClientSession, insertUser, setup } from "../machine/helpers";

const DAY = 86_400_000;

async function guest(h: Awaited<ReturnType<typeof setup>>, opts: { withSession: boolean; lastActiveAt: number }) {
  const user = await insertUser(h.ctx, { email: null });
  await h.ctx.db.update(schema.users).set({ isAnonymous: true, lastActiveAt: opts.lastActiveAt }).where(eq(schema.users.id, user.userId));
  const session = opts.withSession ? await insertClientSession(h.ctx, user.userId) : null;
  return { userId: user.userId, session };
}

describe("anonymous guest cleanup", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps a guest with a live session and purges it once the session is gone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.UTC(2026, 0, 1);
    vi.setSystemTime(now);
    const h = await setup();
    await h.ctx.settings.update({ anonymous: { enabled: true, retentionSeconds: 30 * 24 * 60 * 60 } });
    const active = await guest(h, { withSession: true, lastActiveAt: now - 60 * DAY });
    const abandoned = await guest(h, { withSession: false, lastActiveAt: now - 60 * DAY });

    // Both are idle past retention, but the one still signed in must survive.
    expect(await staleAnonymousUserIds(h.ctx)).toEqual([abandoned.userId]);
    await cleanupAnonymousUsers(h.ctx);
    expect(await getSession(h.ctx, active.session!.sessionId)).toBeTruthy();
    expect((await h.ctx.db.select().from(schema.users).where(eq(schema.users.id, active.userId)))).toHaveLength(1);

    // Once the guest's session ends, it is ordinary stale data.
    await endSession(h.ctx, (await getSession(h.ctx, active.session!.sessionId))!, "ended");
    expect(await staleAnonymousUserIds(h.ctx)).toEqual([active.userId]);
    expect(await cleanupAnonymousUsers(h.ctx)).toBe(1);
    expect((await h.ctx.db.select().from(schema.users).where(eq(schema.users.id, active.userId)))).toHaveLength(0);
  });

  it("does nothing when retention is disabled (the default)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.UTC(2026, 0, 1);
    vi.setSystemTime(now);
    const h = await setup();
    expect(h.ctx.settings.get().anonymous.retentionSeconds).toBe(0);
    const old = await guest(h, { withSession: false, lastActiveAt: now - 3_650 * DAY });
    expect(await staleAnonymousUserIds(h.ctx)).toEqual([]);
    expect(await cleanupAnonymousUsers(h.ctx)).toBe(0);
    expect((await h.ctx.db.select().from(schema.users).where(eq(schema.users.id, old.userId)))).toHaveLength(1);
  });
});
