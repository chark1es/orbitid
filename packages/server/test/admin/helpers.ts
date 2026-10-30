import type { Hono } from "hono";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { ID_PREFIX } from "@orbitid/shared";
import { newId } from "../../src/lib/ids";
import { sha256 } from "../../src/lib/crypto";
import * as s from "../../src/db/schema";
import type { UserJSON } from "@orbitid/shared";
import type { AppContext } from "../../src/context";

export const SECRET_KEY = "sk_test_testsecret";

export interface TestInstance {
  ctx: AppContext;
  app: Hono;
  /** Secret-key authenticated Backend API request. */
  api: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  /** Unauthenticated Frontend API request. */
  fapi: (method: string, path: string, body?: unknown) => Promise<Response>;
}

export async function testApp(): Promise<TestInstance> {
  const ctx = await createContext({ databaseUrl: ":memory:", secretKey: SECRET_KEY, baseUrl: "http://localhost:4000" });
  const app = createApp(ctx);
  const send = (path: string, init: RequestInit): Promise<Response> => Promise.resolve(app.request(path, init));
  return {
    ctx,
    app,
    api: (method, path, body, headers = {}) =>
      send(path, {
        method,
        headers: { authorization: `Bearer ${SECRET_KEY}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    fapi: (method, path, body) =>
      send(path, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

export interface ErrorBody { errors: { code: string; message: string; meta?: Record<string, unknown> }[] }

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function createUser(api: TestInstance["api"], body: Record<string, unknown> = {}): Promise<UserJSON> {
  const res = await api("POST", "/v1/users", { email_address: [`user-${Math.random().toString(36).slice(2)}@example.com`], password: "Sup3r-secret!", ...body });
  if (res.status !== 200) throw new Error(`createUser failed: ${res.status} ${await res.text()}`);
  return await json<UserJSON>(res);
}

/** Inserts a client + active session row directly (session creation belongs to the core sign-in service). */
export async function createSessionFixture(ctx: AppContext, userId: string, overrides: { status?: string; expireAt?: number } = {}) {
  const now = Date.now();
  const clientId = newId(ID_PREFIX.client);
  await ctx.db.insert(s.clients).values({ id: clientId, tokenHash: sha256(`client-token-${clientId}`), createdAt: now, updatedAt: now });
  const sessionId = newId(ID_PREFIX.session);
  await ctx.db
            .insert(s.sessions)
            .values({
              id: sessionId,
              clientId,
              userId,
              status: overrides.status ?? "active",
              lastActiveAt: now,
              expireAt: overrides.expireAt ?? now + 3_600_000,
              abandonAt: now + 86_400_000,
              createdAt: now,
              updatedAt: now,
            });
  return { clientId, sessionId, token: `client-token-${clientId}` };
}

/** Reads the `__orbit_ticket` query parameter out of a generated sign-in / invitation URL. */
export function ticketFromUrl(url: string): string {
  const ticket = new URL(url).searchParams.get("__orbit_ticket");
  if (!ticket) throw new Error(`no ticket in url: ${url}`);
  return ticket;
}

/**
 * A real, verifiable session JWT the way a browser holds one. Used by tests that exercise the possession
 * requirement on `POST /v1/sessions/:id/tokens` without going through a full sign-in.
 */
export async function sessionJwtFor(ctx: AppContext, sessionId: string, userId: string): Promise<string> {
  const { signJwt } = await import("../../src/services/tokens");
  return signJwt(ctx, { sub: userId, sid: sessionId, sts: "active" }, { expiresInSeconds: 60 });
}
