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
import { type TransferProgress } from "./shared";
import { cliCommand, dialectFor, importDatabase, redact, type ImportResult } from "./import";
import type { AppContext } from "../../context";
import { dialect, isPostgresUrl, type Dialect } from "../../db/dialect";
import { TABLE_NAMES } from "../../db/define-schema";
import * as schema from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";

export interface CopyOptions {
  from: string;
  to: string;
  truncate: boolean;
  yes: boolean;
  progress?: TransferProgress;
}

/**
 * `export` in one process and `import` in another, piped together. Connection URLs travel in the
 * children's environment, never in their arguments, and are only ever printed without credentials.
 */
export async function copyDatabase(options: CopyOptions): Promise<ImportResult> {
  const progress = options.progress ?? (() => {});
  if (options.from === options.to) throw new Error("--from and --to are the same database");
  if (options.truncate && !options.yes) throw new Error("--truncate deletes everything in the target database. Pass --yes to confirm.");
  const fromDialect = dialectFor(options.from);
  const toDialect = dialectFor(options.to);
  const childEnv = (url: string, forced: Dialect): NodeJS.ProcessEnv => ({ ...process.env, ORBITID_DATABASE_URL: url, ORBITID_DB_DIALECT: forced });

  progress(`Copying ${redact(options.from)} (${fromDialect}) -> ${redact(options.to)} (${toDialect})`);

  const exporter = cliCommand(["export", "--out", "-"]);
  const importer = cliCommand(["import", "--in", "-", ...(options.truncate ? ["--truncate", "--yes"] : [])]);

  // The exporter's stderr is captured rather than inherited: if the import refuses the data and exits
  // while the export is still writing, the export's own "broken pipe" message is noise, and the import's
  // message is the one the operator needs.
  const exportChild = spawn(exporter.command, exporter.args, { env: childEnv(options.from, fromDialect), stdio: ["ignore", "pipe", "pipe"] });
  const importChild = spawn(importer.command, importer.args, { env: childEnv(options.to, toDialect), stdio: ["pipe", "pipe", "inherit"] });

  let exportErrors = "";
  exportChild.stderr.setEncoding("utf8");
  exportChild.stderr.on("data", (chunk: string) => { exportErrors += chunk; });

  // The import closing its stdin early must be an ordinary failure of this command, not an unhandled
  // event on either side of the pipe.
  importChild.stdin.on("error", () => { exportChild.stdout.unpipe(importChild.stdin); exportChild.stdout.destroy(); });
  exportChild.stdout.on("error", () => { /* surfaced as the import's failure below */ });
  exportChild.stdout.pipe(importChild.stdin);

  let summary = "";
  importChild.stdout.setEncoding("utf8");
  importChild.stdout.on("data", (chunk: string) => { summary += chunk; });

  const exportExit = new Promise<number>((done) => exportChild.on("close", (code) => done(code ?? 1)));
  const importExit = new Promise<number>((done) => importChild.on("close", (code) => done(code ?? 1)));

  const [exportCode, importCode] = await Promise.all([exportExit, importExit]);
  exportChild.stdout.destroy();

  // The import's error is the real cause when both failed (a refused import makes the export's writes fail).
  if (importCode !== 0) throw new Error(`Import into ${redact(options.to)} failed (exit ${importCode})`);
  if (exportCode !== 0) throw new Error(`Export from ${redact(options.from)} failed (exit ${exportCode})${exportErrors ? `: ${exportErrors.trim()}` : ""}`);

  const last = summary.trim().split("\n").filter(Boolean).at(-1);
  let result: ImportResult | undefined;
  if (last) {
    try {
      const parsed = JSON.parse(last) as { orbitid_import?: number; counts?: ImportResult["counts"]; ok?: boolean };
      if (parsed.orbitid_import === 1 && parsed.counts) result = { counts: parsed.counts, ok: parsed.ok ?? true };
    } catch {
      // The import prints its machine-readable summary last; anything else on stdout is ignored.
    }
  }
  if (!result) throw new Error("The import finished without a count summary");

  progress("");
  progress(`Copied ${result.counts.reduce((sum, item) => sum + item.target, 0)} rows in ${result.counts.length} tables`);
  const width = Math.max(...result.counts.map((item) => item.table.length));
  for (const item of result.counts) progress(`  ${item.table.padEnd(width)}  ${String(item.imported).padStart(8)} -> ${String(item.target).padStart(8)}  ${item.ok ? "ok" : "MISMATCH"}`);
  // Machine-readable summary last, matching `import`, so callers need not parse the table above.
  progress(JSON.stringify({ orbitid_copy: 1, ok: result.ok, counts: result.counts }));
  return result;
}
