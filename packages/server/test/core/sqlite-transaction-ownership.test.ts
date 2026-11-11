// SQLite has one synchronous connection per handle. Concurrent async transaction bodies used to interleave on it:
// a second `BEGIN IMMEDIATE` failed with "cannot start a transaction within a transaction", and a contender's
// synchronous lock attempt blocked the whole event loop. These tests pin FIFO ownership, the dedicated writer
// connection, and the refresh rotation semantics that depend on both. They run on Postgres too: the guarantees are
// dialect-independent, and the Postgres path must stay unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { first, inWriteTransaction } from "../../src/lib/db";
import { OAuthError, createApplication, exchangeRefreshToken, issueTokenSet } from "../../src/services/oidc";
import { setup } from "./helpers";
import { insertUser } from "../machine/helpers";

const REDIRECT_URI = "http://localhost:3000/cb";
const TRANSACTION_ERROR = /cannot start a transaction|SQLITE_BUSY|database (table )?is locked/i;

const rejected = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
const fulfilled = <T,>(results: PromiseSettledResult<T>[]) =>
  results.filter((result): result is PromiseFulfilledResult<T> => result.status === "fulfilled");

describe("SQLite write transaction ownership", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function context() {
    const { ctx } = await setup();
    close = () => ctx.close();
    return ctx;
  }

  it("serializes ten simultaneous OIDC refreshes without a transaction error", async () => {
    const ctx = await context();
    const user = await insertUser(ctx);
    const userRow = first(await ctx.db.select().from(s.users).where(eq(s.users.id, user.userId)))!;
    const { row: application } = await createApplication(ctx, {
      name: "Ownership refresh",
      redirectUris: [REDIRECT_URI],
      scopes: "openid offline_access",
    });
    const issued = await issueTokenSet(ctx, {
      application,
      user: userRow,
      scopes: ["openid", "offline_access"],
      family: "family_ownership",
    });
    const original = issued.refresh_token!;

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => exchangeRefreshToken(ctx, application, original)),
    );

    // Never a driver transaction error: a failure is only ever the OAuth outcome this request is allowed to report.
    for (const failure of rejected(results)) {
      expect(failure.reason).toBeInstanceOf(OAuthError);
      expect((failure.reason as OAuthError).error).toBe("invalid_grant");
      expect(String(failure.reason)).not.toMatch(TRANSACTION_ERROR);
    }
    const winners = fulfilled(results);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // Every request that was answered with tokens got the winner's successor: one rotation, not ten.
    expect(new Set(winners.map((result) => result.value.refresh_token)).size).toBe(1);

    const refreshes = (await ctx.db.select().from(s.oauthGrants)
      .where(eq(s.oauthGrants.familyId, "family_ownership")))
      .filter((row) => row.kind === "refresh");
    // One consumed predecessor (marked revoked) plus exactly one live successor.
    expect(refreshes).toHaveLength(2);
    expect(refreshes.filter((row) => row.revoked)).toHaveLength(1);
    expect(refreshes.filter((row) => !row.revoked)).toHaveLength(1);
  });

  it("does not block the event loop while forty transactions wait for their turn", async () => {
    const ctx = await context();
    const startedAt = Date.now();
    let timerFiredAt: number | null = null;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerFiredAt = Date.now();
        resolve();
      }, 200);
    });

    // Each body holds the write transaction for 40 ms; draining forty of them takes about 1.6 s on SQLite (one
    // writer) and about 0.8 s on the Postgres pool. If contenders attempted the SQLite lock synchronously, the
    // timer callback could not run until the whole queue drained.
    const runs = Array.from({ length: 40 }, (_value, index) =>
      inWriteTransaction(ctx, async (tx) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        await tx.update(s.instance).set({ updatedAt: 1_700_000_000_000 + index }).where(eq(s.instance.id, "default"));
      }),
    );

    await timer;
    const lag = timerFiredAt! - startedAt;
    await Promise.all(runs);
    const drainTime = Date.now() - startedAt;

    // The queue really did take much longer than the timer: this is a lag test, not a no-op.
    expect(drainTime).toBeGreaterThan(600);
    expect(lag).toBeLessThan(700);
  });

  it("keeps an open transaction's writes invisible to statements from other async tasks", async () => {
    const ctx = await context();
    const before = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    const marker = 1_234_567_890;

    let reached!: () => void;
    const wrote = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });

    const transaction = inWriteTransaction(ctx, async (tx) => {
      await tx.update(s.instance).set({ updatedAt: marker }).where(eq(s.instance.id, "default"));
      reached();
      await released;
    });
    await wrote;

    try {
      // A different request's ordinary read must not join the open transaction and see its uncommitted write.
      const during = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
      expect(during.updatedAt).toBe(before.updatedAt);
    } finally {
      release();
    }
    await transaction;
    const after = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    expect(after.updatedAt).toBe(marker);
  });
});
