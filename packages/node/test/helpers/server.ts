import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../../../server/src/app";
import { createContext } from "../../../server/src/bootstrap";
import { clearMailOutbox } from "../../../server/src/services/mail";
import type { AppContext } from "../../../server/src/context";

/**
 * A real OrbitID server: the Hono app from `@orbitid/server` behind a `node:http` server on a free
 * port, with a throwaway SQLite database. Nothing is mocked, so the SDK talks to the same code path
 * a self-hosted instance runs.
 */
export interface RealServer {
  context: AppContext;
  url: string;
  secretKey: string;
  close(): Promise<void>;
}

const SECRET_KEY = "sk_test_nodesdksecret";

export async function startRealServer(): Promise<RealServer> {
  const context = await createContext({
    databaseUrl: ":memory:",
    secretKey: SECRET_KEY,
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    dashboardDir: "/nonexistent-dashboard",
  });
  const app = createApp(context);
  clearMailOutbox();

  const server: Server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  // Tokens are minted with `ctx.env.baseUrl` as the issuer; point it at the listening URL so the
  // SDK's default issuer check matches what a real deployment produces.
  context.env.baseUrl = url;

  return {
    context,
    url,
    secretKey: SECRET_KEY,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await context.close();
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
  await server.context.settings.update({ organizations: { enabled: true } });
  const response = await backend(server, "POST", "/v1/organizations", { name, created_by: userId });
  if (response.status !== 200 && response.status !== 201) throw new Error(`organization create failed: ${response.status} ${JSON.stringify(response.body)}`);
  return (response.body as { id: string }).id;
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

export { clearMailOutbox };
