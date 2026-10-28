import { resolve } from "node:path";

export interface Env {
  port: number;
  /** Public URL of this server (Frontend API / issuer), e.g. http://localhost:4000 */
  baseUrl: string;
  /** `postgres://…` (recommended), `pglite://…`, `sqlite:<file>` or ":memory:" (throwaway database for tests). */
  databaseUrl: string;
  /** 32+ char secret for AES-GCM at-rest encryption of private keys / OAuth tokens */
  encryptionKey: string;
  /** True when the operator set the encryption key (required in production). */
  encryptionKeyProvided: boolean;
  /**
   * Backend API secret (sk_test_...). When empty it is derived from an explicit encryption key, so it
   * survives restarts and container rebuilds, or else generated into <dataDir>/keys.json.
   */
  secretKey: string;
  dataDir: string;
  /** Built dashboard (apps/dashboard/dist). The server serves it at `/` when the folder exists. */
  dashboardDir: string;
  nodeEnv: string;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const e = process.env;
  const dataDir = resolve(overrides.dataDir ?? e.ORBITID_DATA_DIR ?? "./data");
  const port = Number(overrides.port ?? e.PORT ?? e.ORBITID_PORT ?? 4000);
  const nodeEnv = overrides.nodeEnv ?? e.NODE_ENV ?? "development";
  const encryptionKey = overrides.encryptionKey ?? e.ORBITID_ENCRYPTION_KEY;
  if (nodeEnv === "production" && !encryptionKey) {
    throw new Error("ORBITID_ENCRYPTION_KEY is required in production. Use a random string of at least 32 characters, for example `openssl rand -base64 32`.");
  }
  return {
    port,
    baseUrl: (overrides.baseUrl ?? e.ORBITID_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    databaseUrl: overrides.databaseUrl ?? e.ORBITID_DATABASE_URL ?? e.DATABASE_URL ?? (e.ORBITID_DATABASE_PATH ? `sqlite:${e.ORBITID_DATABASE_PATH}` : `sqlite:${resolve(dataDir, "orbitid.db")}`),
    encryptionKey: encryptionKey ?? "dev-only-insecure-encryption-key-change-me!!",
    encryptionKeyProvided: !!encryptionKey,
    secretKey: overrides.secretKey ?? e.ORBITID_SECRET_KEY ?? "",
    dataDir,
    dashboardDir: resolve(overrides.dashboardDir ?? e.ORBITID_DASHBOARD_DIR ?? new URL("../../../apps/dashboard/dist", import.meta.url).pathname),
    nodeEnv,
  };
}
