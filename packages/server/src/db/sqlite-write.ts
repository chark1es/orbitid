import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import type { Db } from "./index";

/**
 * One asynchronous write gate for every SQLite write.
 *
 * `better-sqlite3` is synchronous: a statement blocks the event loop until it completes. A second connection that
 * already holds the write lock therefore used to turn an ordinary write into a 5 s synchronous busy-timeout stall,
 * during which the owner of the lock could not release it — the request failed with a 500 and every other request
 * on the event loop waited. Reads are fine (WAL lets them proceed); writes must never compete for the lock.
 *
 * The gate works on three levels:
 *
 * 1. **One FIFO mutex per database.** Every write statement, and every write transaction, takes a turn. A
 *    contender waits in JavaScript (an awaited promise), never in the SQLite driver, so the event loop keeps
 *    running and the holder can always finish and release.
 * 2. **A dedicated writer connection for transaction bodies.** Ordinary statements run on the main connection;
 *    a transaction body runs on a sibling connection that nothing else ever touches, so another request's write
 *    can never join (or commit) a half-finished transaction.
 * 3. **`AsyncLocalStorage` ownership.** A statement issued inside a transaction body belongs to that transaction:
 *    it runs immediately on the transaction's own connection instead of waiting for the gate the transaction
 *    itself holds. A statement issued by any other async task waits for its turn, then runs on the main connection.
 *
 * Reentrancy is supported: calling {@link sqliteWriteTransaction} inside a transaction body joins the outer
 * transaction with a `SAVEPOINT`, so nested work is atomic with its parent and can never deadlock the queue.
 *
 * Reads are deliberately not gated: WAL keeps them running while a writer is busy. Any remaining lock contention
 * (another process on the same file) is retried asynchronously with a short busy timeout rather than stalling.
 */

/** A synchronous busy timeout keeps one loser from stalling the event loop; waiting is done in JS below. */
export const SQLITE_BUSY_TIMEOUT_MS = 50;
/** How long a single gated statement retries an externally held lock before failing loudly. */
const WRITE_DEADLINE_MS = 5_000;
/** How long `BEGIN IMMEDIATE` waits for a lock held by another process/connection before failing loudly. */
const LOCK_DEADLINE_MS = 15_000;

type StatementRunner = { run(query: unknown): unknown };
type BuilderLike = { session?: unknown; execute(): Promise<unknown> };

export interface SqliteWriteTarget {
  /** Drizzle handle for a sibling connection to the same file, used only inside write transactions. */
  db: Db;
  close(): void;
}

class FifoMutex {
  private locked = false;
  private readonly waiters: (() => void)[] = [];

  /** Resolves with an idempotent release function once every earlier holder has released. */
  async acquire(): Promise<() => void> {
    if (!this.locked) this.locked = true;
    else await new Promise<void>((resolve) => this.waiters.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.locked = false;
    };
  }
}

interface WriteState {
  queue: FifoMutex;
  /** Untouched `run` of the main connection (never goes through the gate). */
  mainRun: (query: unknown) => unknown;
  /** Untouched `run` of the connection transaction bodies use. */
  txRun: (query: unknown) => unknown;
  /** Drizzle handle used by transaction bodies (the sibling connection, or the main one when there is none). */
  txHandle: Db;
  target: SqliteWriteTarget | null;
  closed: boolean;
}

interface TransactionContext {
  state: WriteState;
  session: unknown;
  depth: number;
}

const transactionStorage = new AsyncLocalStorage<TransactionContext>();
const states = new WeakMap<object, WriteState>();
let savepointCounter = 0;

/** Registers the write gate and (when available) the dedicated writer connection for a SQLite handle. */
export function registerSqliteWrite(db: Db, target: SqliteWriteTarget | null): void {
  const mainRun = (db as unknown as StatementRunner).run.bind(db);
  const state: WriteState = {
    queue: new FifoMutex(),
    mainRun,
    // Captured before instrumentation: the gate itself must be able to run BEGIN/COMMIT/savepoints unobstructed.
    txRun: target ? (target.db as unknown as StatementRunner).run.bind(target.db) : mainRun,
    txHandle: target?.db ?? db,
    target,
    closed: false,
  };
  states.set(db as object, state);
  installWriteGate(db, state);
  if (target) installWriteGate(target.db, state);
}

export function closeSqliteWrite(db: Db): Promise<void> {
  const state = states.get(db as object);
  if (!state) return Promise.resolve();
  state.closed = true;
  return state.queue.acquire().then((release) => {
    try {
      state.target?.close();
    } finally {
      states.delete(db as object);
      release();
    }
  });
}

function stateFor(db: Db): WriteState {
  const existing = states.get(db as object);
  if (existing) return existing;
  // Defensive: a handle not created by `openSqlite` still gets FIFO ownership on its one connection.
  const rawRun = (db as unknown as StatementRunner).run.bind(db);
  const created: WriteState = {
    queue: new FifoMutex(),
    mainRun: rawRun,
    txRun: rawRun,
    txHandle: db,
    target: null,
    closed: false,
  };
  states.set(db as object, created);
  installWriteGate(db, created);
  return created;
}

function isLockContention(error: unknown): boolean {
  // Drizzle wraps the driver error, so look through `cause` before deciding it is not lock contention.
  const detail = `${String(error)} ${String((error as { cause?: unknown } | null)?.cause ?? "")} ${String((error as { cause?: { cause?: unknown } } | null)?.cause?.cause ?? "")}`;
  return /SQLITE_BUSY|database (table )?is locked/i.test(detail);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retries an externally held write lock asynchronously, so no request stalls the event loop on it. */
async function retryWhileBusy<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WRITE_DEADLINE_MS;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!isLockContention(error) || Date.now() >= deadline) throw error;
      await pause(10 + Math.random() * 25);
    }
  }
}

/**
 * Runs a write while holding the gate, or immediately on the transaction's connection when the caller is a
 * transaction body. The builder's session is redirected to the transaction's connection when a body uses a
 * handle created outside it (`ctx.db` instead of `tx`).
 */
async function gatedWrite<T>(state: WriteState, builder: BuilderLike | null, run: () => Promise<T>): Promise<T> {
  const transaction = transactionStorage.getStore();
  if (transaction && transaction.state === state) {
    if (!builder || builder.session === transaction.session) return retryWhileBusy(run);
    const previous = builder.session;
    builder.session = transaction.session;
    try {
      return await retryWhileBusy(run);
    } finally {
      builder.session = previous;
    }
  }
  const release = await state.queue.acquire();
  try {
    return await retryWhileBusy(run);
  } finally {
    release();
  }
}

/** Runs a raw statement on the transaction's connection when inside a body, otherwise gated on the main one. */
async function gatedRawStatement<T>(
  state: WriteState,
  run: (rawRun: (query: unknown) => unknown) => T,
): Promise<T> {
  const transaction = transactionStorage.getStore();
  if (transaction && transaction.state === state) {
    return retryWhileBusy(async () => run(state.txRun));
  }
  const release = await state.queue.acquire();
  try {
    return await retryWhileBusy(async () => run(state.mainRun));
  } finally {
    release();
  }
}

/** An object returned by a builder chain: thenable queries are the only things the gate wraps. */
function isQueryBuilder(value: unknown): value is BuilderLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { then?: unknown; execute?: unknown };
  return typeof candidate.then === "function" && typeof candidate.execute === "function";
}

/**
 * Wraps an insert/update/delete builder so every terminal path (`await`, `.then()`, `.execute()`) takes the gate.
 * Chain methods that return a new builder are wrapped too; methods that mutate and return the same builder keep
 * the existing wrapper.
 */
function gateBuilder<T extends object>(builder: T, state: WriteState): T {
  return new Proxy(builder, {
    get(target, property, receiver) {
      if (property === "then" || property === "catch" || property === "finally") {
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          gatedWrite(state, target as BuilderLike, () => (target as unknown as BuilderLike).execute())
            .then(onFulfilled, onRejected);
      }
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "execute") {
        return () => gatedWrite(state, target as BuilderLike, () => (target as unknown as BuilderLike).execute());
      }
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        if (result === target) return receiver;
        return isQueryBuilder(result) ? gateBuilder(result, state) : result;
      };
    },
  });
}

/**
 * Replaces the write-producing methods of a Drizzle handle with gated versions, in place. In-place overrides (not
 * a Proxy) keep `vi.spyOn(db, "transaction")`, drizzle's `db.session`/`db.dialect` (used by the migrator) and any
 * other property access working exactly as before.
 */
function installWriteGate(db: Db, state: WriteState): void {
  const handle = db as unknown as Record<string, unknown>;
  for (const method of ["insert", "update", "delete"] as const) {
    const original = handle[method];
    if (typeof original !== "function") continue;
    handle[method] = (...args: unknown[]) => gateBuilder(Reflect.apply(original, db, args) as object, state);
  }

  const run = handle.run;
  if (typeof run === "function") {
    // Raw statements on the main handle are writes or DDL: gate them as well. (Reads use `select`/`all`/`get`.)
    handle.run = (query: unknown) => gatedRawStatement(state, (rawRun) => Reflect.apply(rawRun, null, [query]));
  }

  const execute = handle.execute;
  if (typeof execute === "function") {
    handle.execute = (query: unknown, params?: unknown) =>
      gatedRawStatement(state, (rawRun) => Reflect.apply(rawRun, null, [query, params]));
  }

  handle.transaction = (fn: (tx: Db) => Promise<unknown>, config?: unknown) =>
    transactionFor(state, fn, config);
}

/**
 * Runs `fn` in one serialized write transaction on `db`. `tx` is bound to the dedicated writer connection when one
 * exists, so non-transaction statements issued by other async tasks cannot join it. Inside a transaction body a
 * nested call joins the outer transaction with a savepoint instead of deadlocking on the gate.
 */
export async function sqliteWriteTransaction<T>(
  db: Db,
  fn: (tx: Db) => Promise<T>,
  config?: unknown,
): Promise<T> {
  return transactionFor(stateFor(db), fn, config);
}

async function transactionFor<T>(
  state: WriteState,
  fn: (tx: Db) => Promise<T>,
  _config?: unknown,
): Promise<T> {
  const outer = transactionStorage.getStore();
  if (outer && outer.state === state) return nestedTransaction(state, outer, fn);

  const release = await state.queue.acquire();
  try {
    // The writer connection is dedicated to this module; its busy timeout is already short (set by `openSqlite`).
    // The retry below waits asynchronously for another process instead of blocking Node.
    const deadline = Date.now() + LOCK_DEADLINE_MS;
    for (;;) {
      try {
        await state.txRun(sql`BEGIN IMMEDIATE`);
        break;
      } catch (error) {
        if (Date.now() >= deadline || !isLockContention(error)) throw error;
        await pause(15 + Math.random() * 20);
      }
    }
    try {
      const result = await transactionStorage.run(
        { state, session: (state.txHandle as unknown as { session: unknown }).session, depth: 0 },
        () => fn(state.txHandle),
      );
      // A commit can still meet an external writer's lock; retry it asynchronously, never synchronously.
      await retryWhileBusy(async () => state.txRun(sql`COMMIT`));
      return result;
    } catch (error) {
      // A failed ROLLBACK must not hide the original error; SQLite already ends the transaction in most cases.
      try {
        await state.txRun(sql`ROLLBACK`);
      } catch {
        /* the transaction is already gone */
      }
      throw error;
    }
  } finally {
    release();
  }
}

/** Joins an outer transaction with a savepoint, so nesting is atomic with (and cannot deadlock) the parent. */
async function nestedTransaction<T>(state: WriteState, outer: TransactionContext, fn: (tx: Db) => Promise<T>): Promise<T> {
  const name = `orbitid_sp_${++savepointCounter}`;
  await state.txRun(sql.raw(`SAVEPOINT ${name}`));
  try {
    const result = await transactionStorage.run(
      { state, session: outer.session, depth: outer.depth + 1 },
      () => fn(state.txHandle),
    );
    await state.txRun(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return result;
  } catch (error) {
    try {
      await state.txRun(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
      await state.txRun(sql.raw(`RELEASE SAVEPOINT ${name}`));
    } catch {
      /* the outer transaction will still roll back if the savepoint is already gone */
    }
    throw error;
  }
}

/** Whether the current async task is running inside a write transaction body (for assertions and diagnostics). */
export function insideWriteTransaction(): boolean {
  return transactionStorage.getStore() !== undefined;
}
