// Shared harness for the OIDC provider tests: real HTTP against `app.request` and real crypto.
import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet } from "jose";
import { expect } from "vitest";
import { authHeaders, setup } from "../machine/helpers";

export type Harness = Awaited<ReturnType<typeof setup>>;
export const json = (body: unknown) => JSON.stringify(body);
export const REDIRECT_URI = "http://localhost:3000/callback";
/** Mirrors the server's per-code attempt budget for the device verification endpoints. */
export const DEVICE_ATTEMPT_BUDGET = 10;
export const verifier = () => randomBytes(32).toString("base64url");
export const challengeFor = (v: string) => createHash("sha256").update(v).digest("base64url");

export async function createApp(h: Harness, overrides: Record<string, unknown> = {}) {
  const res = await h.app.request("/v1/oauth_applications", {
    method: "POST",
    headers: authHeaders(),
    body: json({ name: "Test App", redirect_uris: [REDIRECT_URI], consent_screen_enabled: false, ...overrides }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ id: string; client_id: string; client_secret?: string }>;
}

export const form = (h: Harness, path: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
  h.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params).toString(),
  });

export const basic = (clientId: string, secret: string) => ({ authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}` });

export async function authorize(h: Harness, params: Record<string, string>, cookie?: string) {
  const res = await h.app.request(`/oauth/authorize?${new URLSearchParams(params)}`, { headers: cookie ? { cookie } : {} });
  expect(res.status).toBe(302);
  return Object.fromEntries(new URL(res.headers.get("location")!).searchParams);
}

export async function codeFlow(h: Harness, app: { client_id: string; client_secret?: string }, cookie: string, scopes = "openid profile email offline_access") {
  const pkce = verifier();
  const query = await authorize(h, {
    client_id: app.client_id, redirect_uri: REDIRECT_URI, response_type: "code", scope: scopes,
    state: "state-123", nonce: "nonce-123", code_challenge: challengeFor(pkce), code_challenge_method: "S256",
  }, cookie);
  expect(query.code).toBeTruthy();
  const tokenResponse = await form(h, "/oauth/token", {
    grant_type: "authorization_code", code: query.code!, redirect_uri: REDIRECT_URI, code_verifier: pkce,
    client_id: app.client_id, client_secret: app.client_secret ?? "",
  });
  expect(tokenResponse.status).toBe(200);
  return { tokens: await tokenResponse.json() as Record<string, string>, code: query.code! };
}

export const jwks = async (h: Harness) => createLocalJWKSet(await (await h.app.request("/oauth/jwks")).json());
