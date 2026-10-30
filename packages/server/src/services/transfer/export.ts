// Moving an instance's data between the two supported databases (SQLite ↔ Postgres).
//
// The schema is instantiated once per process from a dialect fixed at import time, so a single process
// can never hold both. Every operation here therefore works in exactly one dialect: `export` reads the
// configured database, `import` writes the configured database, and `copy` pipes the first into the
// second through two child processes of the CLI.
//
// The wire format is JSON Lines, one row per line, with portable values only (epoch-ms numbers for
// timestamps, real booleans, JSON for JSON columns). Secrets stay as stored (already hashed or
// encrypted), so password digests, TOTP secrets, passkeys, client token hashes and signing keys survive
// a move unchanged.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { asc, count, getTableColumns, sql } from "drizzle-orm";
import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  CANARY_PREFIX, EXPORT_FORMAT, PAGE_SIZE, primaryKeyColumns, portable, schemaVersion, tableOrder,
  type TransferProgress,
} from "./shared";
import { countRows } from "./import";
import type { AppContext } from "../../context";
import { dialect, isPostgresUrl, type Dialect } from "../../db/dialect";
import { TABLE_NAMES } from "../../db/define-schema";
import * as schema from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";

class JsonLines {
  private failure: Error | undefined;

  constructor(private readonly stream: Writable, private readonly closeStream: boolean) {
    // A closed pipe (the import side exiting early) must surface as an error, not crash the process.
    stream.on("error", (error: Error) => { this.failure ??= error; });
  }

  async write(record: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.stream.write(`${JSON.stringify(record)}\n`)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.stream.off("drain", done);
          this.stream.off("error", done);
          resolve();
        };
        this.stream.once("drain", done);
        this.stream.once("error", done);
      });
    }
    if (this.failure) throw this.failure;
  }

  async end(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.closeStream) return;
    await new Promise<void>((done, fail) => this.stream.end((error?: Error | null) => (error ? fail(error) : done())));
  }
}

export interface ExportOptions {
  /** File path, or `-` for stdout. */
  out: string;
  progress?: TransferProgress;
}

export interface ExportResult {
  dialect: Dialect;
  tables: { table: string; rows: number }[];
  rows: number;
}

/** Streams every copied table to JSON Lines, parents before children, paging on the primary key. */
export async function exportDatabase(ctx: AppContext, options: ExportOptions): Promise<ExportResult> {
  const progress = options.progress ?? (() => {});
  const toStdout = options.out === "-";
  const stream = toStdout ? (process.stdout as unknown as Writable) : createWriteStream(options.out, { encoding: "utf8" });
  const writer = new JsonLines(stream, !toStdout);
  const order = tableOrder();
  const result: ExportResult = { dialect, tables: [], rows: 0 };

  try {
    // Count first, so the header carries the row count per table and an import can verify against the
    // source rather than against however many lines happened to arrive.
    const counts: Record<string, number> = {};
    for (const entry of order) counts[entry.name] = await countRows(ctx, entry);

    await writer.write({
      orbitid_export: EXPORT_FORMAT,
      dialect,
      schema_version: schemaVersion(),
      created_at: Date.now(),
      key_check: encrypt(ctx.env.encryptionKey, `${CANARY_PREFIX}${randomUUID()}`),
      tables: order.map((entry) => entry.name),
      counts,
    });

    for (const entry of order) {
      const columns = Object.entries(entry.columns);
      const keyColumns = primaryKeyColumns(entry.table);
      if (!keyColumns.length) throw new Error(`Table ${entry.name} has no primary key, so it cannot be paged safely`);
      const keyProps = keyColumns.map((key) => columns.find(([, column]) => column.name === key.name)!);
      let cursor: unknown[] | undefined;
      let rows = 0;

      for (;;) {
        const filter = cursor
          ? keyColumns.length === 1
            ? sql`${keyColumns[0]} > ${cursor[0]}`
            : sql`(${sql.join(keyColumns, sql`, `)}) > (${sql.join(cursor.map((value) => sql`${value}`), sql`, `)})`
          : undefined;
        const page = (await ctx.db
          .select()
          .from(entry.table as never)
          .where(filter as never)
          .orderBy(...keyColumns.map((column) => asc(column as never)))
          .limit(PAGE_SIZE)) as unknown as Record<string, unknown>[];
        if (!page.length) break;
        for (const row of page) {
          const values: Record<string, unknown> = {};
          for (const [prop, column] of columns) values[column.name] = portable(row[prop]);
          await writer.write({ t: entry.name, r: values });
        }
        rows += page.length;
        const last = page[page.length - 1]!;
        cursor = keyProps.map(([prop]) => last[prop]);
      }

      // Rows written while the export ran would make the header's counts a lie; the operator is told to
      // stop writes, so a difference means they did not.
      if (rows !== counts[entry.name]) progress(`Warning: ${entry.name} changed during the export (${counts[entry.name]} counted, ${rows} written)`);
      result.tables.push({ table: entry.name, rows });
      result.rows += rows;
      progress(`Exported ${entry.name}: ${rows} row${rows === 1 ? "" : "s"}`);
    }
    await writer.end();
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return result;
}
