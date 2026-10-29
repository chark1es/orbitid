// Two real OrbitID instances in one test process, each on its own loopback port with a throwaway database.
//
// Everything the tests drive is real HTTP: no adapter stubs, no fetch interception. Instance A acts as the
// identity provider (its OIDC provider module is a genuine OP); instance B is the relying party under test.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import type { AppContext } from "../../src/context";
import { clearMailOutbox } from "../../src/services/mail";
import { resetJwksCache } from "../../src/lib/safe-fetch";
import { resetOAuthProviders } from "../../src/services/oauth-providers";

export interface FedServer {
  ctx: AppContext;
  url: string;
  secretKey: string;
  close(): Promise<void>;
}

const SECRET = "sk_test_federation_secret";

/**
 * Boots a server on an ephemeral port. The port is known before the context exists, so `baseUrl` (the
 * issuer of tokens and discovery documents) matches what a client reaches over HTTP.
 */
export async function startFedServer(opts: { databaseUrl?: string; secretKey?: string } = {}): Promise<FedServer> {
  let listener: ReturnType<typeof getRequestListener> | null = null;
  const server: Server = createServer((req, res) => {
    if (!listener) {
      res.statusCode = 503;
      res.end();
      return;
    }
    void listener(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const secretKey = opts.secretKey ?? SECRET;
  const ctx = await createContext({
    databaseUrl: opts.databaseUrl ?? ":memory:",
    secretKey,
    baseUrl: url,
    nodeEnv: "test",
    dashboardDir: "/nonexistent-dashboard",
  });
  clearMailOutbox();
  listener = getRequestListener(createApp(ctx).fetch);

  return {
    ctx,
    url,
    secretKey,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

/** Both processes share the module-level caches; forget them between cases. */
export function resetFederationCaches() {
  resetJwksCache();
  resetOAuthProviders();
}

// ───────────── a real browser: cookie jar + manual redirects ─────────────

export interface FetchResult {
  status: number;
  headers: Headers;
  location: URL | null;
  text: string;
  json: <T = Record<string, unknown>>() => T;
}

export class Browser {
  readonly cookies = new Map<string, string>();

  cookieHeader(): string | undefined {
    return this.cookies.size ? [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ") : undefined;
  }

  async request(url: string, init: { method?: string; json?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<FetchResult> {
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader();
    if (cookie) headers.set("cookie", cookie);
    let body: string | undefined;
    if (init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.form).toString();
    } else if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await fetch(url, { method: init.method ?? (body ? "POST" : "GET"), headers, body, redirect: "manual" });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(/;\s*/);
      const [name, ...rest] = pair!.split("=");
      const value = rest.join("=");
      const expired = attributes.some((a) => /^max-age=0$/i.test(a)) || value === "";
      if (!name) continue;
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    const location = res.headers.get("location");
    return {
      status: res.status,
      headers: res.headers,
      location: location ? new URL(location, url) : null,
      text,
      json<T = Record<string, unknown>>() {
        return JSON.parse(text) as T;
      },
    };
  }

  get(url: string) {
    return this.request(url, { method: "GET" });
  }
}

/** Backend API call on a server (secret key). */
export async function backend(server: FedServer, method: string, path: string, body?: unknown): Promise<FetchResult> {
  const res = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${server.secretKey}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    location: null,
    text,
    json<T = Record<string, unknown>>() {
      return JSON.parse(text) as T;
    },
  };
}

export interface CreatedUser {
  id: string;
  email: string;
  password: string;
}

/** Creates a user with a verified email through the Backend API (the admin path, as a seeding script would). */
export async function createUser(server: FedServer, opts: { email?: string; password?: string; firstName?: string; lastName?: string } = {}): Promise<CreatedUser> {
  const email = opts.email ?? `user-${Math.random().toString(36).slice(2, 10)}@example.com`;
  const password = opts.password ?? "Sup3rSecret!";
  const res = await backend(server, "POST", "/v1/users", {
    email_address: [email],
    password,
    first_name: opts.firstName ?? "Ada",
    last_name: opts.lastName ?? "Lovelace",
  });
  if (res.status !== 200) throw new Error(`createUser failed (${res.status}): ${res.text.slice(0, 300)}`);
  return { id: res.json<{ id: string }>().id, email, password };
}

/** Signs in through the Frontend API, leaving the `__client` cookie in `browser`. */
export async function signIn(browser: Browser, server: FedServer, identifier: string, password: string) {
  const res = await browser.request(`${server.url}/v1/client/sign_ins`, { json: { identifier, password } });
  const body = res.json<{ response?: { status?: string; created_session_id?: string }; errors?: unknown }>();
  if (res.status !== 200) throw new Error(`sign-in failed (${res.status}): ${res.text.slice(0, 300)}`);
  if (body.response?.status !== "complete" || !body.response.created_session_id) {
    throw new Error(`sign-in did not complete: ${res.text.slice(0, 300)}`);
  }
  return body.response;
}

/** The `__client` cookie's value, for direct DB lookups. */
export function clientToken(browser: Browser): string {
  const token = browser.cookies.get("__client");
  if (!token) throw new Error("browser has no __client cookie");
  return token;
}

// ───────────── driving an OrbitID instance as an OIDC IdP ─────────────

export interface OAuthApplication {
  id: string;
  client_id: string;
  client_secret: string;
}

/** Registers a confidential client on instance A with exactly one registered redirect URI. */
export async function createOAuthApplication(idp: FedServer, redirectUri: string, opts: { consentScreen?: boolean; name?: string } = {}): Promise<OAuthApplication> {
  const res = await backend(idp, "POST", "/v1/oauth_applications", {
    name: opts.name ?? "Relying party",
    redirect_uris: [redirectUri],
    scopes: "openid profile email",
    public: false,
    consent_screen_enabled: opts.consentScreen ?? true,
  });
  if (res.status !== 201) throw new Error(`oauth application create failed (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json<OAuthApplication>();
}

/** The parameters OrbitID put on the provider's authorize URL, in the shape the IdP expects back. */
export function authorizeParams(authorizeUrl: URL) {
  const q = authorizeUrl.searchParams;
  return {
    client_id: q.get("client_id")!,
    redirect_uri: q.get("redirect_uri")!,
    state: q.get("state")!,
    nonce: q.get("nonce"),
    code_challenge: q.get("code_challenge"),
    code_challenge_method: q.get("code_challenge_method"),
    scope: q.get("scope"),
    response_type: q.get("response_type"),
  };
}

export interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  nonce?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  scope?: string | null;
  response_type?: string | null;
  prompt?: string | null;
}

/**
 * What a signed-in browser does at the IdP: GET the authorize URL, then (when the application shows a
 * consent screen) POST the decision the same way the consent component does. Returns the callback URL the
 * IdP redirects to.
 */
export async function authorizeAtIdp(idp: FedServer, browser: Browser, params: AuthorizeParams, opts: { approve?: boolean } = {}): Promise<URL> {
  const url = new URL(`${idp.url}/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) if (value != null && value !== "") url.searchParams.set(key, value);
  const authorize = await browser.get(url.toString());
  if (authorize.status !== 302 || !authorize.location) {
    throw new Error(`authorize did not redirect (${authorize.status}): ${authorize.text.slice(0, 300)}`);
  }
  // Consented before: straight back to the client with a code.
  if (authorize.location.href.startsWith(params.redirect_uri)) return authorize.location;

  // A consent screen: the SPA forwards every authorize parameter plus the decision.
  const info = await browser.get(`${idp.url}/oauth/consent_info?${new URLSearchParams({
    client_id: params.client_id,
    scope: params.scope ?? "openid",
    redirect_uri: params.redirect_uri,
  })}`);
  if (info.status !== 200) throw new Error(`consent_info failed (${info.status}): ${info.text.slice(0, 300)}`);
  const decision = await browser.request(`${idp.url}/oauth/consent`, {
    json: {
      client_id: params.client_id,
      approve: opts.approve ?? true,
      scope: params.scope ?? "openid profile email",
      redirect_uri: params.redirect_uri,
      state: params.state,
      response_type: params.response_type ?? "code",
      nonce: params.nonce ?? null,
      code_challenge: params.code_challenge ?? null,
      code_challenge_method: params.code_challenge_method ?? null,
    },
  });
  if (decision.status !== 200) throw new Error(`consent failed (${decision.status}): ${decision.text.slice(0, 300)}`);
  return new URL(decision.json<{ redirect_url: string }>().redirect_url);
}
