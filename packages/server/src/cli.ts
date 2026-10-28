#!/usr/bin/env -S npx tsx
import { createContext } from "./bootstrap";
import { startServer } from "./index";
import { copyDatabase, exportDatabase, importDatabase, type TransferProgress } from "./services/transfer";

const USAGE = `Usage: orbitid [command]

  start              Run migrations and start the server (default)
  migrate            Run migrations and exit
  keys               Print the publishable and secret keys and exit
  export [--out f]   Write every table to JSON Lines (default: stdout)
  import [--in f]    Load JSON Lines into the configured database
                     [--truncate --yes]
  copy --from <url> --to <url> [--truncate --yes]
                     Copy one database into another in one step
  help               Show this message

Configuration is read from environment variables (see packages/server/.env.example).`;

function describeDatabase(label: string, driver: string): string[] {
  const lines = [`  Database        : ${label}`];
  if (driver === "sqlite") lines.push("                    SQLite is fine for trying things out. Set ORBITID_DATABASE_URL=postgres://… for production.");
  return lines;
}

/** `--out file`, `--out=file`; boolean flags take no value. */
function parseArgs(argv: string[], flags: { values: string[]; booleans: string[] }): { values: Record<string, string>; booleans: Set<string> } {
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (flags.booleans.includes(name)) { booleans.add(name); continue; }
    if (flags.values.includes(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value === "") throw new Error(`--${name} needs a value`);
      values[name] = value;
      continue;
    }
    throw new Error(`Unknown option: --${name}`);
  }
  return { values, booleans };
}

/** Progress goes to stderr so `export --out -` can be piped into `import --in -`. */
const stderrProgress: TransferProgress = (message) => { process.stderr.write(`${message}\n`); };

// Piping into a consumer that stops reading (a refused import, `head`) closes stdout. Report that as an
// ordinary failure instead of letting an unhandled EPIPE print a stack trace.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") {
    process.stderr.write("The consumer closed the output stream before the command finished.\n");
    process.exit(1);
  }
  throw error;
});

async function main() {
  const command = process.argv[2] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }

  if (command === "export") {
    const args = parseArgs(process.argv.slice(3), { values: ["out"], booleans: [] });
    const ctx = await createContext();
    try {
      const result = await exportDatabase(ctx, { out: args.values.out ?? "-", progress: stderrProgress });
      if (args.values.out !== "-") console.log(`Exported ${result.rows} rows in ${result.tables.length} tables from ${ctx.database.label} to ${args.values.out}`);
    } finally {
      await ctx.close();
    }
    return;
  }

  if (command === "import") {
    const args = parseArgs(process.argv.slice(3), { values: ["in"], booleans: ["truncate", "yes"] });
    const ctx = await createContext();
    try {
      const result = await importDatabase(ctx, {
        in: args.values.in ?? "-",
        truncate: args.booleans.has("truncate"),
        yes: args.booleans.has("yes"),
        progress: stderrProgress,
      });
      // Machine-readable summary last, so `copy` can print a per-table comparison from it.
      console.log(JSON.stringify({ orbitid_import: 1, ok: result.ok, counts: result.counts }));
    } finally {
      await ctx.close();
    }
    return;
  }

  if (command === "copy") {
    const args = parseArgs(process.argv.slice(3), { values: ["from", "to"], booleans: ["truncate", "yes"] });
    const from = args.values.from;
    const to = args.values.to;
    if (!from || !to) throw new Error("copy needs --from <database url> and --to <database url>. See: orbitid help");
    if (args.booleans.has("truncate") && !args.booleans.has("yes")) throw new Error("--truncate deletes everything in the target database. Pass --yes to confirm.");
    await copyDatabase({ from, to, truncate: args.booleans.has("truncate"), yes: args.booleans.has("yes"), progress: (message) => console.log(message) });
    return;
  }

  if (command === "migrate" || command === "keys") {
    const ctx = await createContext();
    if (command === "migrate") console.log(`Migrations applied to ${ctx.database.label}`);
    else {
      console.log(`Publishable key : ${ctx.publishableKey}`);
      console.log(`Secret key      : ${ctx.env.secretKey}`);
    }
    await ctx.close();
    return;
  }

  if (command !== "start") {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
  }

  const server = await startServer();
  const { ctx } = server;
  const dashboard = ctx.env.dashboardDir;
  console.log(`\n  OrbitID is running at ${ctx.env.baseUrl}`);
  console.log(`  Dashboard       : ${(await import("node:fs")).existsSync(dashboard) ? ctx.env.baseUrl : "not built (run: bun run --filter @orbitid/dashboard build)"}`);
  console.log(`  Publishable key : ${ctx.publishableKey}`);
  // Logs are widely readable, so a production instance shows only the end of the secret key.
  console.log(`  Secret key      : ${ctx.env.nodeEnv === "production" ? `${ctx.env.secretKey.slice(0, 8)}…${ctx.env.secretKey.slice(-4)} (print it with: keys)` : ctx.env.secretKey}`);
  console.log(`  JWKS            : ${ctx.env.baseUrl}/.well-known/jwks.json`);
  for (const line of describeDatabase(ctx.database.label, ctx.database.driver)) console.log(line);
  console.log("");

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
