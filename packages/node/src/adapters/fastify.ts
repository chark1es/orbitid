import type { AuthContext } from "../auth-context";
import type { HeaderValue, RequestLike } from "../request";
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

/** Structural subset of Fastify's `FastifyRequest`; no dependency on Fastify's types. */
export interface FastifyRequestLike {
  headers: Record<string, HeaderValue>;
  auth?: AuthContext | null;
  method?: string;
  url?: string;
}

/** Structural subset of Fastify's `FastifyReply`. */
export interface FastifyReplyLike {
  code(statusCode: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(payload?: unknown): unknown;
}

/** Structural subset of Fastify's `FastifyInstance`. */
export interface FastifyInstanceLike {
  decorateRequest(name: string, value: unknown): unknown;
  addHook(name: "onRequest" | "preHandler", hook: FastifyHook): unknown;
}

export type FastifyHook = (request: FastifyRequestLike, reply: FastifyReplyLike, done: (error?: Error) => void) => void;

export interface FastifyPluginOptions extends AdapterOptions {
  unauthenticatedMessage?: string;
  forbiddenMessage?: string;
}

function sendError(reply: FastifyReplyLike, status: number, body: ErrorResponseBody): void {
  reply.code(status).header("cache-control", "private, no-store");
  if (status === 401) reply.header("www-authenticate", 'Bearer realm="orbitid"');
  reply.send(body);
}

function toRequestLike(request: FastifyRequestLike): RequestLike {
  return { headers: request.headers ?? {} };
}

/** Fills `request.auth` when a route-level hook ran without the plugin, so both work alone. */
async function attachAuth(orbit: AuthResolver, request: FastifyRequestLike, reply: FastifyReplyLike, options: FastifyPluginOptions): Promise<{ ok: true; auth: AuthContext | null } | { ok: false }> {
  if (request.auth !== undefined) return { ok: true, auth: request.auth };
  const result = await resolveAuth(orbit, toRequestLike(request), options);
  if (result.kind === "error") {
    sendError(reply, 503, authUnavailable());
    return { ok: false };
  }
  request.auth = result.kind === "signed-in" ? result.auth : null;
  return { ok: true, auth: request.auth };
}

/**
 * Fastify plugin: decorates `request.auth` (default `null`) and verifies the session in a
 * `preHandler` hook, so handlers can read `request.auth` for both signed-in and signed-out visitors.
 *
 * ```ts
 * await app.register(orbit.fastifyPlugin(), { prefix: "/api" });
 *
 * app.get("/me", { preHandler: orbit.fastifyRequireAuth() }, (request) => request.auth);
 * ```
 */
export function fastifyPlugin(orbit: AuthResolver, options: FastifyPluginOptions = {}) {
  return function orbitIdPlugin(fastify: FastifyInstanceLike, _opts: unknown, done: (error?: Error) => void): void {
    fastify.decorateRequest("auth", null);
    fastify.addHook("preHandler", (request, reply, next) => {
      void (async () => {
        const result = await resolveAuth(orbit, toRequestLike(request), options);
        if (result.kind === "error") {
          sendError(reply, 503, authUnavailable());
          return;
        }
        request.auth = result.kind === "signed-in" ? result.auth : null;
        next();
      })().catch(next);
    });
    done();
  };
}

/** Route-level `preHandler` requiring a signed-in caller. */
export function fastifyRequireAuth(orbit: AuthResolver, options: FastifyPluginOptions = {}): FastifyHook {
  return (request, reply, done) => {
    void (async () => {
      const attached = await attachAuth(orbit, request, reply, options);
      if (!attached.ok) return;
      if (!attached.auth) {
        sendError(reply, 401, unauthorized(options.unauthenticatedMessage));
        return;
      }
      done();
    })().catch(done);
  };
}

/** Route-level `preHandler` requiring an organization permission. */
export function fastifyRequirePermission(orbit: AuthResolver, permission: string | string[], options: FastifyPluginOptions = {}): FastifyHook {
  const permissions = toList(permission);
  return (request, reply, done) => {
    void (async () => {
      const attached = await attachAuth(orbit, request, reply, options);
      if (!attached.ok) return;
      if (!attached.auth) {
        sendError(reply, 401, unauthorized(options.unauthenticatedMessage));
        return;
      }
      const missing = permissions.find((entry) => !attached.auth!.has({ permission: entry }));
      if (missing) {
        sendError(reply, 403, options.forbiddenMessage ? forbidden(options.forbiddenMessage) : missingPermission(missing));
        return;
      }
      done();
    })().catch(done);
  };
}

/** Route-level `preHandler` requiring an organization role. */
export function fastifyRequireRole(orbit: AuthResolver, role: string | string[], options: FastifyPluginOptions = {}): FastifyHook {
  const roles = toList(role);
  return (request, reply, done) => {
    void (async () => {
      const attached = await attachAuth(orbit, request, reply, options);
      if (!attached.ok) return;
      if (!attached.auth) {
        sendError(reply, 401, unauthorized(options.unauthenticatedMessage));
        return;
      }
      if (!roles.some((entry) => attached.auth!.has({ role: entry }))) {
        sendError(reply, 403, forbiddenRole(options.forbiddenMessage));
        return;
      }
      done();
    })().catch(done);
  };
}
