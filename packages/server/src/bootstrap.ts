import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodePublishableKey } from "@orbitid/shared";
import { randomToken } from "./lib/crypto";
import { createDb, runMigrations } from "./db";
import { loadEnv, type Env } from "./env";
import { createSettingsStore } from "./settings";
import type { AppContext } from "./context";
import { seedRbac } from "./services/orgs";

/** Creates DB, runs migrations, loads/creates keys, seeds RBAC. Does not listen. */
export async function createContext(overrides: Partial<Env> = {}): Promise<AppContext> {
  const env = loadEnv(overrides);
  const { db, raw } = createDb(env.databasePath);
  runMigrations(db);
  let secretKey = env.secretKey;
  if (!secretKey && env.databasePath !== ":memory:") {
    mkdirSync(env.dataDir, { recursive: true });
    const f = resolve(env.dataDir, "keys.json");
    if (existsSync(f)) secretKey = JSON.parse(readFileSync(f, "utf8")).secretKey;
    else { secretKey = `sk_test_${randomToken(24)}`; writeFileSync(f, JSON.stringify({ secretKey }, null, 2), { mode: 0o600 }); }
  }
  if (!secretKey) secretKey = `sk_test_${randomToken(24)}`;
  const ctx: AppContext = {
    db, raw, env: { ...env, secretKey }, settings: createSettingsStore(db),
    publishableKey: encodePublishableKey(env.baseUrl, env.nodeEnv === "production" ? "live" : "test"),
  };
  await seedRbac(ctx);
  return ctx;
}
