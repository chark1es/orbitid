// The write gate: ordinary writes and write transactions never contend for SQLite's single write lock. A contender
// waits asynchronously (an awaited promise) instead of stalling the event loop in the driver, so the lock holder can
// always release it and no request turns contention into a 500. These run against Postgres too: the guarantees are
// dialect-independent and the Postgres path must stay unchanged.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { first, inWriteTransaction } from "../../src/lib/db";
import { hit } from "../../src/lib/rate-limit";
import { setup, signUpUser } from "./helpers";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("SQLite write gate", () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function context() {
    const { ctx, app } = await setup();
    close = () => ctx.close();
    return { ctx, app };
  }

  it("serves a token refresh while another transaction holds the write lock (no 500, no event-loop stall)", async () => {
    const { ctx, app } = await context();
    const signedIn = await signUpUser(app);

    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    // The repro from the review: a writer transaction whose release is scheduled a little later. The token request
    // used to wait synchronously in better-sqlite3's 5 s busy timeout and then fail with a 500.
    const transaction = inWriteTransaction(ctx, async (tx) => {
      await tx.update(s.instance).set({ updatedAt: 1_600_000_000_000 }).where(eq(s.instance.id, "default"));
      entered();
      await pause(300);
    });
    await writing;

    const timerStartedAt = Date.now();
    let timerFiredAt = 0;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => { timerFiredAt = Date.now(); resolve(); }, 50);
    });

    const requestedAt = Date.now();
    const response = await signedIn.client.request(`/v1/client/sessions/${signedIn.sessionId}/tokens`, {
      method: "POST",
      body: {},
    });
    const elapsed = Date.now() - requestedAt;

    await transaction;
    await timer;

    expect(response.status).toBe(200);
    expect((await response.json() as { jwt?: string }).jwt).toBeTruthy();
    // It waited for the actual write (300 ms), never for a 5 s lock timeout, and it did not fail.
    expect(elapsed).toBeLessThan(1_000);
    // The event loop kept running while the request waited: the timer was never parked behind a driver lock.
    expect(timerFiredAt - timerStartedAt).toBeLessThan(1_500);
  });

  it("queues an ordinary write issued while a transaction is open, then runs it", async () => {
    const { ctx } = await context();
    const before = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    const marker = before.updatedAt + 999;
    const settled = { value: false };

    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const transaction = inWriteTransaction(ctx, async (tx) => {
      await tx.update(s.instance).set({ updatedAt: before.updatedAt + 1 }).where(eq(s.instance.id, "default"));
      entered();
      await held;
    });
    await writing;

    const ordinary = ctx.db.update(s.instance).set({ updatedAt: marker }).where(eq(s.instance.id, "default"));
    const ordinaryDone = ordinary.then(() => { settled.value = true; });

    // The write is waiting for the gate, not racing the open transaction.
    await pause(100);
    expect(settled.value).toBe(false);

    release();
    await transaction;
    await ordinaryDone;

    expect(settled.value).toBe(true);
    const after = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    expect(after.updatedAt).toBe(marker);
  });

  it("keeps the event loop responsive with forty transactions and mixed ordinary writes", async () => {
    const { ctx } = await context();
    const startedAt = Date.now();
    let timerFiredAt: number | null = null;
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => { timerFiredAt = Date.now(); resolve(); }, 200);
    });

    const transactions = Array.from({ length: 40 }, (_value, index) =>
      inWriteTransaction(ctx, async (tx) => {
        await pause(40);
        await tx.update(s.instance).set({ updatedAt: 1_700_000_000_000 + index }).where(eq(s.instance.id, "default"));
      }),
    );
    // Ordinary writes interleaved with the queue: rate-limit counters and activity updates take the same gate.
    const ordinary = Array.from({ length: 20 }, (_value, index) =>
      hit(ctx, `gate:mixed:${index}`, 1_000, 60_000),
    );

    await timer;
    const lag = timerFiredAt! - startedAt;
    await Promise.all([...transactions, ...ordinary]);
    const drainTime = Date.now() - startedAt;

    // The queue really did take much longer than the timer: this is a lag test, not a no-op.
    expect(drainTime).toBeGreaterThan(600);
    expect(lag).toBeLessThan(700);
    const row = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    expect(row.updatedAt).toBeGreaterThanOrEqual(1_700_000_000_000);
  });

  it("joins a nested transaction instead of deadlocking the queue", async () => {
    const { ctx } = await context();
    const outer = 1_800_000_000_000;
    const inner = outer + 1;

    await inWriteTransaction(ctx, async (tx) => {
      await tx.update(s.instance).set({ updatedAt: outer }).where(eq(s.instance.id, "default"));
      // Before the gate this never resolved and every later writer waited forever.
      await inWriteTransaction(ctx, async (nested) => {
        await nested.update(s.instance).set({ updatedAt: inner }).where(eq(s.instance.id, "default"));
      });
    });

    const row = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    expect(row.updatedAt).toBe(inner);

    // Writers queued behind the nested transaction still run.
    await ctx.db.update(s.instance).set({ updatedAt: inner + 1 }).where(eq(s.instance.id, "default"));
    expect(first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!.updatedAt).toBe(inner + 1);
  });

  it("rolls back only the nested savepoint when a nested transaction fails", async () => {
    const { ctx } = await context();
    const outer = 1_900_000_000_000;

    await inWriteTransaction(ctx, async (tx) => {
      await tx.update(s.instance).set({ updatedAt: outer }).where(eq(s.instance.id, "default"));
      await expect(inWriteTransaction(ctx, async (nested) => {
        await nested.update(s.instance).set({ updatedAt: outer + 1 }).where(eq(s.instance.id, "default"));
        throw new Error("nested failure");
      })).rejects.toThrow("nested failure");
      // The outer body continues and commits its own write.
    });

    const row = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    expect(row.updatedAt).toBe(outer);
  });

  it("routes a write issued on the outer handle inside a body through the transaction's connection", async () => {
    const { ctx } = await context();
    if (ctx.database.driver !== "sqlite") return; // SQLite-only ALS ownership; Postgres has no lock to avoid.
    const before = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    const inside = before.updatedAt + 123;

    await expect(inWriteTransaction(ctx, async (tx) => {
      // Deliberately not `tx`: AsyncLocalStorage must redirect it to the open transaction's connection.
      await ctx.db.update(s.instance).set({ updatedAt: inside }).where(eq(s.instance.id, "default"));
      const visible = first(await tx.select().from(s.instance).where(eq(s.instance.id, "default")))!;
      expect(visible.updatedAt).toBe(inside);
      throw new Error("rollback entire transaction");
    })).rejects.toThrow("rollback entire transaction");

    const after = first(await ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))!;
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});
