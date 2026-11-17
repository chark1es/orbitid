import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, importJWK, type JWK } from "jose";

/**
 * A real OrbitID server for the Node SDK tests: the Rust binary (`target/release/orbitid`, or
 * `ORBITID_BIN`) on a free port with a throwaway Postgres database. Nothing is mocked, so the
 * SDK talks to the same process a self-hosted instance runs.
 *
 * Postgres is required: `ORBITID_TEST_PG_ADMIN_URL` (default
 * `postgres://orbit:orbit@localhost:5432/postgres`) must be an admin connection allowed to
 * CREATE/DROP DATABASE. The database is created with `psql` and dropped in `close()`.
 */
export interface RealServer {
  url: string;
  secretKey: string;
  /** Admin URL of the throwaway database, used by the test-only signing helper. */
  databaseUrl: string;
  close(): Promise<void>;
}

const SECRET_KEY = "sk_test_nodesdksecret";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef";
const ADMIN_URL = process.env.ORBITID_TEST_PG_ADMIN_URL ?? "postgres://orbit:orbit@localhost:5432/postgres";
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

function binaryPath(): string {
  return process.env.ORBITID_BIN ?? join(REPO_ROOT, "target/release/orbitid");
}

function databaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function psql(sql: string): void {
  const result = spawnSync("psql", [ADMIN_URL, "-v", "ON_ERROR_STOP=1", "-tAc", sql], { encoding: "utf8" });
  if (result.error) throw new Error(`psql failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr.trim()}`);
}

function psqlScalar(url: string, sql: string): string {
  const result = spawnSync("psql", [url, "-v", "ON_ERROR_STOP=1", "-tAc", sql], { encoding: "utf8" });
  if (result.error) throw new Error(`psql failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`psql failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function createDatabase(name: string): void {
  psql(`CREATE DATABASE "${name}"`);
}

function dropDatabase(name: string): void {
  // A replica or a half-started server may still hold a connection; terminate it first.
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}' AND pid <> pg_backend_pid()`,
  );
  psql(`DROP DATABASE IF EXISTS "${name}"`);
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!port) throw new Error("could not find a free port");
  return port;
}

async function waitForReady(url: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "no answer";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`orbitid exited with ${child.exitCode}\n${logs()}`);
    for (const path of ["/ready", "/health"]) {
      try {
        const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
        lastError = `${path} returned ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`orbitid did not become ready at ${url} (${lastError})\n${logs()}`);
}

export async function startRealServer(): Promise<RealServer> {
  const binary = binaryPath();
  const database = `orbitid_sdk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createDatabase(database);

  const dataDir = mkdtempSync(join(tmpdir(), "orbitid-sdk-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const output: string[] = [];
  const child = spawn(binary, ["start"], {
    env: {
      ...process.env,
      PORT: String(port),
      ORBITID_BASE_URL: url,
      ORBITID_DATABASE_URL: databaseUrl(database),
      ORBITID_ENCRYPTION_KEY: ENCRYPTION_KEY,
      ORBITID_SECRET_KEY: SECRET_KEY,
      ORBITID_DATA_DIR: dataDir,
      ORBITID_DASHBOARD_DIR: "/nonexistent-dashboard",
      NODE_ENV: "test",
      RUST_LOG: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const logs = () => output.join("").slice(-4000);
  try {
    await waitForReady(url, child, logs);
  } catch (error) {
    child.kill("SIGKILL");
    dropDatabase(database);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    url,
    secretKey: SECRET_KEY,
    databaseUrl: databaseUrl(database),
    async close() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        const exited = await Promise.race([
          new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
        ]);
        if (!exited) child.kill("SIGKILL");
      }
      dropDatabase(database);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export interface TestUser {
  userId: string;
  sessionId: string;
  email: string;
  password: string;
  /** Client cookie jar from the Frontend API sign-up (kept for follow-up calls). */
  cookie: string;
  /** A fresh session JWT minted by the Backend API. */
  token: string;
}

/** Creates a user and a real session through the Backend API, then mints a session JWT. */
export async function createUserWithSession(server: RealServer, options: { email?: string } = {}): Promise<TestUser> {
  const email = options.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = "Sup3rSecret!";
  const created = await backend(server, "POST", "/v1/users", { email_address: [email], password, first_name: "Test" });
  const userId = (created.body as { id: string }).id;

  const cookie = await signInCookie(server, email, password);

  // The session id is not returned by the Backend create endpoint, so read it from the client state
  // the sign-in produced (the Frontend API response carries `client.sessions`).
  const clientState = await fetchJson(`${server.url}/v1/client`, { headers: { cookie } });
  const sessions = (clientState.body as { response?: { sessions?: { id: string }[] } }).response?.sessions ?? [];
  const sessionId = sessions[0]?.id;
  if (!sessionId) throw new Error("sign-in produced no session");

  const token = await mintSessionToken(server, sessionId, cookie);
  return { userId, sessionId, email, password, cookie, token };
}

/**
 * Mints a session JWT the way the browser does: from the Frontend API, authenticated by the client's own
 * `__client` cookie. The Backend API only mints for a caller that presents the session's own token.
 */
export async function mintSessionToken(server: RealServer, sessionId: string, cookie: string): Promise<string> {
  const minted = await fetchJson(`${server.url}/v1/client/sessions/${sessionId}/tokens`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  if (minted.status !== 200) throw new Error(`token mint failed: ${minted.status} ${JSON.stringify(minted.body)}`);
  return (minted.body as { jwt: string }).jwt;
}

/** Signs in through the real Frontend API and returns the `__client` cookie. */
export async function signInCookie(server: RealServer, email: string, password: string): Promise<string> {
  const response = await fetch(`${server.url}/v1/client/sign_ins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  // The server rotates the client token when a session is created, so the same cookie can be set twice: keep the last value.
  const jar = new Map<string, string>();
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  if (!cookie) throw new Error(`sign-in returned no cookie (status ${response.status})`);
  return cookie;
}

export interface BackendResult {
  status: number;
  body: unknown;
  headers: Headers;
}

/** Secret-key authenticated Backend API call against the real server. */
export async function backend(server: RealServer, method: string, path: string, body?: unknown): Promise<BackendResult> {
  return fetchJson(`${server.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${server.secretKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function fetchJson(url: string, init: RequestInit = {}): Promise<BackendResult> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

/** Creates an organization owned by `userId` and returns its id (creator becomes `org:admin`). */
export async function createOrganization(server: RealServer, userId: string, name = "Acme"): Promise<string> {
  await backend(server, "PATCH", "/v1/instance", { organizations: { enabled: true } });
  const response = await backend(server, "POST", "/v1/organizations", { name, created_by: userId });
  if (response.status !== 200 && response.status !== 201) throw new Error(`organization create failed: ${response.status} ${JSON.stringify(response.body)}`);
  return (response.body as { id: string }).id;
}

/**
 * Decrypts the active instance signing key the same way `orbitid_core::crypto` seals it:
 * scrypt(secret, "orbitid-at-rest", 32) + AES-256-GCM in `v1.<iv>.<tag>.<ciphertext>`.
 */
async function readPrivateJwk(server: RealServer): Promise<JWK> {
  // The first signing key is minted lazily by the JWKS endpoint; ask for it so a
  // test that only needs a custom token still has a key to sign with.
  const jwks = await fetch(`${server.url}/.well-known/jwks.json`);
  if (!jwks.ok) throw new Error(`JWKS fetch failed: ${jwks.status}`);
  const encrypted = psqlScalar(
    server.databaseUrl,
    "SELECT private_jwk_enc FROM signing_keys WHERE active = true ORDER BY created_at DESC LIMIT 1",
  );
  const [version, ivPart, tagPart, ciphertextPart] = encrypted.split(".");
  if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart) {
    throw new Error("active signing key is not in the v1 ciphertext format");
  }
  const key = scryptSync(ENCRYPTION_KEY, "orbitid-at-rest", 32);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as JWK;
}

/**
 * Signs an arbitrary session JWT with the running instance's active signing key.
 *
 * This is test-only and lives entirely client-side: it reads and decrypts the key with the test
 * `ORBITID_ENCRYPTION_KEY`, then signs with `jose`. The server has no test endpoint or CLI hook for
 * minting custom claims.
 */
export async function signJwtForTest(
  server: RealServer,
  claims: Record<string, unknown>,
  expiresInSeconds: number,
  issuer?: string,
): Promise<string> {
  const jwk = await readPrivateJwk(server);
  const key = await importJWK(jwk, "RS256");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", ...(typeof jwk.kid === "string" ? { kid: jwk.kid } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader(header)
    .setIssuer(issuer ?? server.url)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + expiresInSeconds)
    .sign(key);
}

/** Signs in again with the organization active so the minted JWT carries `org_*` claims. */
export async function tokenWithOrganization(server: RealServer, user: TestUser, organizationId: string): Promise<string> {
  const client = await fetchJson(`${server.url}/v1/client`, { headers: { cookie: user.cookie } });
  const sessions = (client.body as { response?: { sessions?: { id: string; status: string }[] } }).response?.sessions ?? [];
  const active = sessions.find((session) => session.status === "active");
  if (!active) throw new Error("no active session");
  const touched = await fetchJson(`${server.url}/v1/client/sessions/${active.id}/touch`, {
    method: "POST",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    body: JSON.stringify({ active_organization_id: organizationId }),
  });
  if (touched.status !== 200) throw new Error(`touch failed: ${touched.status} ${JSON.stringify(touched.body)}`);
  return mintSessionToken(server, active.id, user.cookie);
}
