import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodePublishableKey } from "@orbitid/shared";
import { hmacSha256, randomToken } from "./lib/crypto";
import { createDb, runMigrations } from "./db";
import { loadEnv, type Env } from "./env";
import { createSettingsStore } from "./settings";
import type { AppContext } from "./context";
import { seedRbac } from "./services/orgs";

/** Creates DB, runs migrations, loads/creates keys, seeds RBAC. Does not listen. */
export async function createContext(overrides: Partial<Env> = {}): Promise<AppContext> {
  const env = loadEnv(overrides);
  const handle = await createDb(env.databaseUrl);
  await runMigrations(handle);
  const mode = env.nodeEnv === "production" ? "live" : "test";
  let secretKey = env.secretKey;
  if (!secretKey && env.encryptionKeyProvided) secretKey = `sk_${mode}_${hmacSha256(env.encryptionKey, "orbitid/secret-key").toString("base64url")}`;
  if (!secretKey && env.databaseUrl !== ":memory:") {
    mkdirSync(env.dataDir, { recursive: true });
    const f = resolve(env.dataDir, "keys.json");
    if (existsSync(f)) secretKey = JSON.parse(readFileSync(f, "utf8")).secretKey;
    else { secretKey = `sk_${mode}_${randomToken(24)}`; writeFileSync(f, JSON.stringify({ secretKey }, null, 2), { mode: 0o600 }); }
  }
  if (!secretKey) secretKey = `sk_${mode}_${randomToken(24)}`;
  const ctx: AppContext = {
    db: handle.db,
    database: { driver: handle.driver, dialect: handle.dialect, label: handle.label },
    env: { ...env, secretKey },
    settings: await createSettingsStore(handle.db, { production: env.nodeEnv === "production", encryptionKey: env.encryptionKey, env }),
    publishableKey: encodePublishableKey(env.baseUrl, mode),
    close: () => handle.close(),
  };
  await seedRbac(ctx);
  return ctx;
}
