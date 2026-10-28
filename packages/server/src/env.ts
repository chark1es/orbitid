import { resolve } from "node:path";

export interface Env {
  port: number;
  /** Public URL of this server (Frontend API / issuer), e.g. http://localhost:4000 */
  baseUrl: string;
  /** `postgres://…` (recommended), `pglite://…`, `sqlite:<file>` or ":memory:" (throwaway database for tests). */
  databaseUrl: string;
  /** 32+ char secret for AES-GCM at-rest encryption of private keys / OAuth tokens */
  encryptionKey: string;
  /** Backend API secret (sk_test_...). If empty, the bootstrap generates one into <dataDir>/keys.json */
  secretKey: string;
  dataDir: string;
  nodeEnv: string;
}

export function loadEnv(overrides: Partial<Env> = {}): Env {
  const e = process.env;
  const dataDir = resolve(overrides.dataDir ?? e.ORBITID_DATA_DIR ?? "./data");
  const port = Number(overrides.port ?? e.PORT ?? e.ORBITID_PORT ?? 4000);
  return {
    port,
    baseUrl: (overrides.baseUrl ?? e.ORBITID_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    databaseUrl: overrides.databaseUrl ?? e.ORBITID_DATABASE_URL ?? e.DATABASE_URL ?? (e.ORBITID_DATABASE_PATH ? `sqlite:${e.ORBITID_DATABASE_PATH}` : `sqlite:${resolve(dataDir, "orbitid.db")}`),
    encryptionKey: overrides.encryptionKey ?? e.ORBITID_ENCRYPTION_KEY ?? "dev-only-insecure-encryption-key-change-me!!",
    secretKey: overrides.secretKey ?? e.ORBITID_SECRET_KEY ?? "",
    dataDir,
    nodeEnv: overrides.nodeEnv ?? e.NODE_ENV ?? "development",
  };
}
