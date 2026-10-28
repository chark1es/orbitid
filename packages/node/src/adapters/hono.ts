import type { AuthContext } from "../auth-context";
import type { RequestLike } from "../request";
import {
  authUnavailable,
  forbidden,
  forbiddenRole,
  missingPermission,
  resolveAuth,
  toList,
  unauthorized,
  type AdapterOptions,
  type AuthResolver,
  type ErrorResponseBody,
} from "./shared";

/** Structural subset of Hono's `Context`; no dependency on Hono's types. */
export interface HonoContextLike {
  req: {
    raw?: Request;
    header(name: string): string | undefined;
  };
  set(key: string, value: unknown): void;
  json(body: unknown, status: number): Response;
}

export type HonoNext = () => Promise<void>;
/** Same signature as Hono's `MiddlewareHandler`: `Response` short-circuits, `undefined` continues. */
export type HonoMiddleware = (c: HonoContextLike, next: HonoNext) => Promise<Response | void>;

/** `Variables` shape for `new Hono<{ Variables: OrbitIdHonoVariables }>()`. */
export interface OrbitIdHonoVariables {
  auth: AuthContext | null;
}

export interface HonoOptions extends AdapterOptions {
  unauthenticatedMessage?: string;
  forbiddenMessage?: string;
}

function toRequestLike(c: HonoContextLike): RequestLike {
  // The node-server adapter hands the original Fetch `Request` through `c.req.raw`.
  if (c.req.raw?.headers) return { headers: c.req.raw.headers };
  const headers: Record<string, string | undefined> = {};
  for (const name of ["authorization", "cookie"]) {
    const value = c.req.header(name);
    if (value) headers[name] = value;
  }
  return { headers };
}

function respond(c: HonoContextLike, status: number, body: ErrorResponseBody): Response {
  const response = c.json(body, status);
  response.headers.set("cache-control", "private, no-store");
  if (status === 401) response.headers.set("www-authenticate", 'Bearer realm="orbitid"');
  return response;
}

/**
 * Optional-auth middleware: sets `c.get("auth")` to the caller or `null` for signed-out visitors.
 *
 * ```ts
 * app.use("*", orbit.honoMiddleware());
 * app.get("/me", (c) => c.json({ userId: c.get("auth")?.userId ?? null }));
 * ```
 */
export function honoMiddleware(orbit: AuthResolver, options: HonoOptions = {}): HonoMiddleware {
  return async (c, next) => {
    const result = await resolveAuth(orbit, toRequestLike(c), options);
    if (result.kind === "error") return respond(c, 503, authUnavailable());
    c.set("auth", result.kind === "signed-in" ? result.auth : null);
    await next();
  };
}

/** Middleware requiring a signed-in caller; stops the chain with a 401 JSON body. */
export function honoRequireAuth(orbit: AuthResolver, options: HonoOptions = {}): HonoMiddleware {
  return async (c, next) => {
    const result = await resolveAuth(orbit, toRequestLike(c), options);
    if (result.kind === "error") return respond(c, 503, authUnavailable());
    if (result.kind === "signed-out") return respond(c, 401, unauthorized(options.unauthenticatedMessage));
    c.set("auth", result.auth);
    await next();
  };
}

/** Middleware requiring an organization permission. */
export function honoRequirePermission(orbit: AuthResolver, permission: string | string[], options: HonoOptions = {}): HonoMiddleware {
  const permissions = toList(permission);
  return async (c, next) => {
    const result = await resolveAuth(orbit, toRequestLike(c), options);
    if (result.kind === "error") return respond(c, 503, authUnavailable());
    if (result.kind === "signed-out") return respond(c, 401, unauthorized(options.unauthenticatedMessage));
    c.set("auth", result.auth);
    const missing = permissions.find((entry) => !result.auth.has({ permission: entry }));
    if (missing) {
      const body = options.forbiddenMessage ? forbidden(options.forbiddenMessage) : missingPermission(missing);
      return respond(c, 403, body);
    }
    await next();
  };
}

/** Middleware requiring an organization role. */
export function honoRequireRole(orbit: AuthResolver, role: string | string[], options: HonoOptions = {}): HonoMiddleware {
  const roles = toList(role);
  return async (c, next) => {
    const result = await resolveAuth(orbit, toRequestLike(c), options);
    if (result.kind === "error") return respond(c, 503, authUnavailable());
    if (result.kind === "signed-out") return respond(c, 401, unauthorized(options.unauthenticatedMessage));
    c.set("auth", result.auth);
    if (!roles.some((entry) => result.auth.has({ role: entry }))) return respond(c, 403, forbiddenRole(options.forbiddenMessage));
    await next();
  };
}
