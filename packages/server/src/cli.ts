#!/usr/bin/env -S npx tsx
import { startServer } from "./index";

async function main() {
  const cmd = process.argv[2] ?? "start";
  if (cmd !== "start") { console.error(`Unknown command: ${cmd}\nUsage: orbitid [start]`); process.exit(1); }
  const { ctx } = await startServer();
  console.log(`\n  OrbitID server running at ${ctx.env.baseUrl}`);
  console.log(`  Publishable key : ${ctx.publishableKey}`);
  console.log(`  Secret key      : ${ctx.env.secretKey}`);
  console.log(`  JWKS            : ${ctx.env.baseUrl}/.well-known/jwks.json\n`);
}
main().catch((e) => { console.error(e); process.exit(1); });
