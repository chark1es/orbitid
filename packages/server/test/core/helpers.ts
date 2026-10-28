import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { clearMailOutbox, latestCodeFor, latestEmail, latestLinkFor } from "../../src/services/mail";

/** In-memory instance + a fetch-like client that persists the `__client` cookie. */
export async function setup(overrides: Parameters<typeof createContext>[0] = {}) {
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: "sk_test_testsecret",
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    ...overrides,
  });
  clearMailOutbox();
  const app = createApp(ctx);
  return { ctx, app };
}

export interface TestClient {
  request(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  json<T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T>;
  cookie: string | undefined;
}

export function testClient(app: ReturnType<typeof createApp>, initialCookie?: string): TestClient {
  const jar = new Map<string, string>();
  if (initialCookie) for (const part of initialCookie.split(/;\s*/)) { const [name, ...rest] = part.split("="); if (name) jar.set(name, rest.join("=")); }
  const header = () => (jar.size ? [...jar].map(([name, value]) => `${name}=${value}`).join("; ") : undefined);
  const request = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    const cookie = header();
    if (cookie) headers.set("cookie", cookie);
    let body: BodyInit | undefined;
    if (init.body instanceof FormData) {
      body = init.body;
    } else if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }
    const res = await app.request(path, {
      method: init.method ?? (body !== undefined ? "POST" : "GET"),
      headers,
      body,
      redirect: "manual",
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(/;\s*/);
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attributes.some((a) => /^max-age=0$/i.test(a)) || value === "";
      if (expired) jar.delete(name!);
      else jar.set(name!, value);
    }
    return res;
  };
  return {
    request,
    async json<T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) {
      const res = await request(path, init);
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
      }
    },
    get cookie() {
      return header();
    },
  };
}

export interface ApiErrorItemShape { code: string; message: string; long_message?: string; meta?: Record<string, unknown> }

/** Runtime guard for the API error wire format. */
export function errorsOf(body: unknown): ApiErrorItemShape[] {
  if (!body || typeof body !== "object" || !("errors" in body)) return [];
  const errors = body.errors;
  if (!Array.isArray(errors)) return [];
  return errors.filter((item): item is ApiErrorItemShape => !!item && typeof item === "object" && "code" in item && typeof item.code === "string" && "message" in item && typeof item.message === "string");
}

export interface SignedUpUser { email: string; password: string; userId: string; sessionId: string; client: TestClient }

/** Full email+password sign-up including the email verification code. */
export async function signUpUser(app: ReturnType<typeof createApp>, opts: { email?: string; password?: string; firstName?: string; username?: string } = {}): Promise<SignedUpUser> {
  const client = testClient(app);
  const email = opts.email ?? `user${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = opts.password ?? "Sup3rSecret!";
  const created = await client.json<{ response: { id: string; status: string; unverified_fields: string[] } }>("/v1/client/sign_ups", {
    body: { email_address: email, password, first_name: opts.firstName ?? "Test", username: opts.username },
  });
  if (created.response.status !== "missing_requirements") throw new Error(`unexpected sign-up status ${created.response.status}`);
  await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_code" } });
  const code = latestCodeFor(email);
  if (!code) throw new Error("no verification code was emailed");
  const verified = await client.json<{ response: { status: string; created_session_id: string; created_user_id: string } }>(
    `/v1/client/sign_ups/${created.response.id}/attempt_verification`,
    { body: { strategy: "email_code", code } },
  );
  if (verified.response.status !== "complete") throw new Error(`sign-up did not complete: ${JSON.stringify(verified.response)}`);
  return {
    email,
    password,
    userId: verified.response.created_user_id,
    sessionId: verified.response.created_session_id,
    client,
  };
}

export interface ClientState {
  response: {
    id: string;
    sessions: { id: string; status: string; expire_at: number; last_active_token: { jwt: string } | null; user: { id: string } | null }[];
    last_active_session_id: string | null;
    sign_in: { id: string; status: string; first_factor_verification: { status: string; external_verification_redirect_url?: string | null } | null; created_session_id: string | null } | null;
    sign_up: { id: string; status: string; missing_fields: string[]; created_session_id: string | null } | null;
  };
  client: ClientState["response"];
}

/** GET /v1/client typed response. */
export const getClient = (client: TestClient) => client.json<ClientState>("/v1/client");

/** Signs in with password on a fresh client. */
export async function signInWithPassword(app: ReturnType<typeof createApp>, email: string, password: string): Promise<{ client: TestClient; state: ClientState; sessionId: string }> {
  const client = testClient(app);
  const raw = await client.json<{ response: { status: string; created_session_id: string | null }; client: ClientState["response"] }>("/v1/client/sign_ins", {
    body: { identifier: email, password },
  });
  const sessionId = raw.response.created_session_id;
  if (!sessionId) throw new Error(`sign-in did not complete: ${JSON.stringify(raw)}`);
  return { client, state: { response: raw.client, client: raw.client }, sessionId };
}

export const lastEmailCode = (to: string) => latestCodeFor(to);
export const lastLink = (to: string) => latestLinkFor(to);
export const lastMail = (to: string) => latestEmail(to);
