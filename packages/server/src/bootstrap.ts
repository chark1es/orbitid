import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodePublishableKey } from "@orbitid/shared";
import { hmacSha256, randomToken } from "./lib/crypto";
import { createDb, runMigrations } from "./db";
import { loadEnv, type Env } from "./env";
import { createSettingsStore } from "./settings";
import type { AppContext } from "./context";
import { seedRbac } from "./services/orgs";
import { assertSigningKeysReadable } from "./services/tokens";

/** Creates DB, runs migrations, loads/creates keys, seeds RBAC. Does not listen. */
export async function createContext(overrides: Partial<Env> = {}): Promise<AppContext> {
  const env = loadEnv(overrides);
  const handle = await createDb(env.databaseUrl);
  await runMigrations(handle);
  const mode = env.nodeEnv === "production" ? "live" : "test";
  // The data directory holds uploads and, when no secret key is supplied by the environment, keys.json.
  // It is part of every instance's runtime contract, so create it even when neither file is written yet.
  mkdirSync(env.dataDir, { recursive: true });
  let secretKey = env.secretKey;
  if (!secretKey && env.encryptionKeyProvided) secretKey = `sk_${mode}_${hmacSha256(env.encryptionKey, "orbitid/secret-key").toString("base64url")}`;
  if (!secretKey && env.databaseUrl !== ":memory:") {
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
  // Existing signing keys must decrypt with this process's encryption key: fail at boot rather than on the
  // first token refresh (which every browser would experience as being signed out).
  await assertSigningKeysReadable(ctx);
  return ctx;
}
