#!/usr/bin/env -S npx tsx
import { createContext } from "./bootstrap";
import { startServer } from "./index";

const USAGE = `Usage: orbitid [command]

  start     Run migrations and start the server (default)
  migrate   Run migrations and exit
  keys      Print the publishable and secret keys and exit
  help      Show this message

Configuration is read from environment variables (see packages/server/.env.example).`;

function describeDatabase(label: string, driver: string): string[] {
  const lines = [`  Database        : ${label}`];
  if (driver === "sqlite") lines.push("                    SQLite is fine for trying things out. Set ORBITID_DATABASE_URL=postgres://… for production.");
  return lines;
}

async function main() {
  const command = process.argv[2] ?? "start";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
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
  console.log(`  Secret key      : ${ctx.env.secretKey}`);
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
