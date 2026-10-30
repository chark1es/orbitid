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
  /** Email fallbacks; the dashboard settings win when they are set. */
  resendApiKey: string;
  smtpUrl: string;
  emailFrom: string;
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
  if (encryptionKey && encryptionKey.length < 32) {
    throw new Error("ORBITID_ENCRYPTION_KEY must be at least 32 characters long, for example `openssl rand -base64 32`.");
  }
  const databaseUrl = overrides.databaseUrl ?? e.ORBITID_DATABASE_URL ?? e.DATABASE_URL;
  const baseUrl = (overrides.baseUrl ?? e.ORBITID_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(baseUrl);
  if (!encryptionKey && (!local || /^postgres(ql)?:/.test(databaseUrl ?? ""))) {
    throw new Error("ORBITID_ENCRYPTION_KEY is required with Postgres or a public ORBITID_BASE_URL. Without it the built-in development key would protect stored secrets. Use `openssl rand -base64 32`.");
  }
  const secretKey = overrides.secretKey ?? e.ORBITID_SECRET_KEY ?? "";
  if (nodeEnv === "production" && secretKey && secretKey.length < 32) {
    throw new Error("ORBITID_SECRET_KEY must be at least 32 random characters in production. Omit it to derive a strong key from ORBITID_ENCRYPTION_KEY.");
  }
  return {
    port,
    baseUrl,
    databaseUrl: databaseUrl ?? (e.ORBITID_DATABASE_PATH ? `sqlite:${e.ORBITID_DATABASE_PATH}` : `sqlite:${resolve(dataDir, "orbitid.db")}`),
    encryptionKey: encryptionKey ?? "dev-only-insecure-encryption-key-change-me!!",
    encryptionKeyProvided: !!encryptionKey,
    secretKey,
    dataDir,
    dashboardDir: resolve(overrides.dashboardDir ?? e.ORBITID_DASHBOARD_DIR ?? new URL("../../../apps/dashboard/dist", import.meta.url).pathname),
    nodeEnv,
    resendApiKey: overrides.resendApiKey ?? e.ORBITID_RESEND_API_KEY ?? "",
    smtpUrl: overrides.smtpUrl ?? e.ORBITID_SMTP_URL ?? "",
    emailFrom: overrides.emailFrom ?? e.ORBITID_EMAIL_FROM ?? "",
  };
}
