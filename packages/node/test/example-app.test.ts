import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../../server/src/app";
import { createContext } from "../../server/src/bootstrap";

/**
 * Boots the example app as a separate process against a real OrbitID server, so the example's own
 * `node:http` server, env handling and SDK wiring are exercised rather than re-tested in isolation.
 */
let server: Server | null = null;
let instance: Awaited<ReturnType<typeof createContext>> | null = null;
let appProcess: ChildProcess | null = null;
let apiUrl = "";
let exampleUrl = "";
let secretKey = "sk_test_exampleappsecret";
let sessionToken = "";
let endpointSecret = "";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

async function jsonFetch(url: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(url, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  instance = await createContext({
    databaseUrl: ":memory:",
    secretKey,
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    dashboardDir: "/nonexistent-dashboard",
  });
  const app = createApp(instance);
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  instance.env.baseUrl = apiUrl;

  const auth = { authorization: `Bearer ${secretKey}`, "content-type": "application/json" };

  // A user + real session token.
  await jsonFetch(`${apiUrl}/v1/users`, { method: "POST", headers: auth, body: JSON.stringify({ email_address: ["example@example.com"], password: "Sup3rSecret!" }) });
  const signIn = await fetch(`${apiUrl}/v1/client/sign_ins`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: "example@example.com", password: "Sup3rSecret!" }),
  });
  // The server rotates the client token on sign-in, so the cookie can be set twice: keep the last value.
  const jar = new Map<string, string>();
  for (const line of signIn.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const clientState = await jsonFetch(`${apiUrl}/v1/client`, { headers: { cookie } });
  const sessionId = (clientState.body.response.sessions as { id: string }[])[0]!.id;
  const minted = await jsonFetch(`${apiUrl}/v1/sessions/${sessionId}/tokens`, { method: "POST", headers: auth });
  sessionToken = minted.body.jwt as string;

  const endpoint = await jsonFetch(`${apiUrl}/v1/webhooks/endpoints`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ url: "https://app.example.com/api/webhooks", description: "example", event_types: ["user.created"] }),
  });
  endpointSecret = endpoint.body.secret as string;

  // Start the example on a free port.
  const port = await freePort();
  exampleUrl = `http://127.0.0.1:${port}`;
  // Same shape as the package script (`node --import tsx <file>`), without `--env-file`: the test
  // passes the variables directly.
  appProcess = spawn(process.execPath, ["--import", "tsx", "apps/example-node/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ORBITID_SECRET_KEY: secretKey,
      ORBITID_API_URL: apiUrl,
      ORBITID_WEBHOOK_SECRET: endpointSecret,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const startupLog: string[] = [];
  appProcess.stdout?.on("data", (chunk: Buffer) => startupLog.push(chunk.toString()));
  appProcess.stderr?.on("data", (chunk: Buffer) => startupLog.push(chunk.toString()));
  appProcess.once("exit", (code) => {
    if (code !== 0) console.error("[example-node exited]", code, startupLog.join(""));
  });
  try {
    await waitForServer(exampleUrl, 20_000);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${startupLog.join("")}`);
  }
}, 60_000);

afterAll(async () => {
  appProcess?.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  await instance?.close();
});

describe("example-node app", () => {
  it("answers 401 on /me without a session", async () => {
    const response = await jsonFetch(`${exampleUrl}/me`);
    expect(response.status).toBe(401);
    expect(response.body.errors[0].code).toBe("authentication_invalid");
  });

  it("answers 200 on /me with a bearer token", async () => {
    const response = await jsonFetch(`${exampleUrl}/me`, { headers: { authorization: `Bearer ${sessionToken}` } });
    expect(response.status).toBe(200);
    expect(response.body.userId).toMatch(/^user_/);
  });

  it("answers 200 on /me with the __session cookie", async () => {
    const response = await jsonFetch(`${exampleUrl}/me`, { headers: { cookie: `__session=${sessionToken}` } });
    expect(response.status).toBe(200);
    expect(response.body.sessionId).toMatch(/^sess_/);
  });

  it("refuses /admin/users without the organization permission", async () => {
    const response = await jsonFetch(`${exampleUrl}/admin/users`, { headers: { authorization: `Bearer ${sessionToken}` } });
    expect(response.status).toBe(403);
    expect(response.body.errors[0].code).toBe("org_permission_required");
  });

  it("lists users on /admin/users when the permission is present", async () => {
    const { signJwt } = await import("../../server/src/services/tokens");
    const token = await signJwt(instance!, { sub: "user_example", sid: "sess_example", org_permissions: ["org:sys_memberships:manage"] }, { expiresInSeconds: 60, issuer: apiUrl });
    const response = await jsonFetch(`${exampleUrl}/admin/users`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.users)).toBe(true);
  });

  it("verifies a signed webhook and refuses a tampered one", async () => {
    const body = JSON.stringify({ id: "evt_1", object: "event", type: "user.created", timestamp: Date.now(), instance_id: "ins_1", data: { id: "user_1" } });
    const timestamp = Math.floor(Date.now() / 1000);
    const key = Buffer.from(endpointSecret.replace(/^whsec_/, ""), "base64");
    const signature = `v1,${createHmac("sha256", key).update(`msg_1.${timestamp}.${body}`).digest("base64")}`;
    const headers = { "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": String(timestamp), "svix-signature": signature };

    const ok = await jsonFetch(`${exampleUrl}/api/webhooks`, { method: "POST", headers, body });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ received: true });

    const bad = await jsonFetch(`${exampleUrl}/api/webhooks`, { method: "POST", headers, body: body.replace("user_1", "user_2") });
    expect(bad.status).toBe(400);
  });

  it("runs the list-users script against the same instance", async () => {
    const result = await runScript(["apps/example-node/src/list-users.ts"], {
      ORBITID_SECRET_KEY: secretKey,
      ORBITID_API_URL: apiUrl,
      LIMIT: "5",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("example@example.com");
  }, 40_000);

  it("answers 503, not 500, when the key set cannot be reached", async () => {
    const deadPort = await freePort();
    const port = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "apps/example-node/src/server.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(port), ORBITID_SECRET_KEY: secretKey, ORBITID_API_URL: `http://127.0.0.1:${deadPort}` },
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      await waitForServer(`http://127.0.0.1:${port}`, 20_000);
      const res = await jsonFetch(`http://127.0.0.1:${port}/me`, { headers: { authorization: `Bearer ${sessionToken}` } });
      expect(res.status).toBe(503);
      expect(res.body.errors[0].code).toBe("authentication_unavailable");
    } finally {
      child.kill("SIGTERM");
    }
  });

  it("answers 404 with the server's error shape for an unknown route", async () => {
    const response = await jsonFetch(`${exampleUrl}/nope`);
    expect(response.status).toBe(404);
    expect(response.body.errors[0].code).toBe("resource_not_found");
  });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Runs one of the example's scripts in a child process, as `bun run <script>` would. */
async function runScript(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`example app did not start at ${url}`);
}
