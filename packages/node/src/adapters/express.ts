import type { WebhookEvent } from "@orbitid/shared";
import type { AuthContext } from "../auth-context";
import type { OrbitIdNode } from "../client";
import { OrbitIdError } from "../errors";
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

/** Enough of Express's `Request` to authenticate and attach `auth`. Works with `node:http` too. */
export interface ExpressRequest {
  headers: Record<string, HeaderValue>;
  auth?: AuthContext | null;
  method?: string;
  url?: string;
  originalUrl?: string;
  /** Raw body produced by `express.raw({ type: "application/json" })` (webhook handler only). */
  body?: unknown;
}

/** Enough of Express's `Response` to answer with JSON. */
export interface ExpressResponse {
  status(code: number): ExpressResponse;
  json(body: unknown): ExpressResponse;
  setHeader?(name: string, value: string): unknown;
}

export type ExpressNext = (error?: unknown) => void;
export type ExpressHandler = (req: ExpressRequest, res: ExpressResponse, next: ExpressNext) => void;

export interface ExpressMiddlewareOptions extends AdapterOptions {
  /** Message used for the 401 body. */
  unauthenticatedMessage?: string;
  /** Message used for the 403 body when the permission is missing. */
  forbiddenMessage?: string;
}

function writeError(res: ExpressResponse, status: number, body: ErrorResponseBody): void {
  res.status(status);
  res.setHeader?.("cache-control", "private, no-store");
  if (status === 401) res.setHeader?.("www-authenticate", 'Bearer realm="orbitid"');
  res.json(body);
}

/** Express request objects are also valid `RequestLike` values; `authenticate` reads `req.headers`. */
function toRequestLike(req: ExpressRequest): RequestLike {
  return { headers: req.headers ?? {} };
}

/**
 * Optional-auth middleware: verifies the session token when present and always sets `req.auth`
 * (`null` when the visitor is signed out), then continues. Use it when the route renders both states.
 *
 * ```ts
 * app.use(orbit.expressMiddleware());
 * ```
 */
export function expressMiddleware(orbit: AuthResolver, options: ExpressMiddlewareOptions = {}): ExpressHandler {
  return (req, res, next) => {
    void (async () => {
      const result = await resolveAuth(orbit, toRequestLike(req), options);
      if (result.kind === "error") {
        writeError(res, 503, authUnavailable());
        return;
      }
      req.auth = result.kind === "signed-in" ? result.auth : null;
      next();
    })().catch(next);
  };
}

/**
 * Require a signed-in caller: 401 with `{ errors: [...] }` and `www-authenticate` otherwise.
 *
 * ```ts
 * app.get("/dashboard", orbit.requireAuth(), (req, res) => res.json({ userId: req.auth!.userId }));
 * ```
 */
export function requireAuth(orbit: AuthResolver, options: ExpressMiddlewareOptions = {}): ExpressHandler {
  return (req, res, next) => {
    void (async () => {
      const result = await resolveAuth(orbit, toRequestLike(req), options);
      if (result.kind === "error") {
        writeError(res, 503, authUnavailable());
        return;
      }
      if (result.kind === "signed-out") {
        writeError(res, 401, unauthorized(options.unauthenticatedMessage));
        return;
      }
      req.auth = result.auth;
      next();
    })().catch(next);
  };
}

/**
 * Require a signed-in caller whose organization permissions include `permission`.
 * Answered as 401 when signed out and 403 when the permission is missing.
 *
 * ```ts
 * app.post("/members", orbit.requirePermission("org:sys_memberships:manage"), handler);
 * ```
 */
export function requirePermission(orbit: AuthResolver, permission: string | string[], options: ExpressMiddlewareOptions = {}): ExpressHandler {
  const permissions = toList(permission);
  return (req, res, next) => {
    void (async () => {
      const result = await resolveAuth(orbit, toRequestLike(req), options);
      if (result.kind === "error") {
        writeError(res, 503, authUnavailable());
        return;
      }
      if (result.kind === "signed-out") {
        writeError(res, 401, unauthorized(options.unauthenticatedMessage));
        return;
      }
      req.auth = result.auth;
      const missing = permissions.find((entry) => !result.auth.has({ permission: entry }));
      if (missing) {
        const body = options.forbiddenMessage ? forbidden(options.forbiddenMessage) : missingPermission(missing);
        writeError(res, 403, body);
        return;
      }
      next();
    })().catch(next);
  };
}

/** Require an organization role (`org:admin`, `org:member`, or a custom role key). */
export function requireRole(orbit: AuthResolver, role: string | string[], options: ExpressMiddlewareOptions = {}): ExpressHandler {
  const roles = toList(role);
  return (req, res, next) => {
    void (async () => {
      const result = await resolveAuth(orbit, toRequestLike(req), options);
      if (result.kind === "error") {
        writeError(res, 503, authUnavailable());
        return;
      }
      if (result.kind === "signed-out") {
        writeError(res, 401, unauthorized(options.unauthenticatedMessage));
        return;
      }
      req.auth = result.auth;
      if (!roles.some((entry) => result.auth.has({ role: entry }))) {
        writeError(res, 403, forbiddenRole(options.forbiddenMessage));
        return;
      }
      next();
    })().catch(next);
  };
}

export interface WebhookHandlerOptions {
  /** Signing secret override; defaults to `createOrbitId({ webhookSecret })` / `ORBITID_WEBHOOK_SECRET`. */
  secret?: string;
  /**
   * Notification hook for rejected deliveries (bad signature, stale timestamp, parsed body). The
   * response is still the standard 400; use this for logging or metrics.
   */
  onError?: (error: unknown, req: ExpressRequest) => void;
  /** Response body for a verified event. Defaults to `{ received: true }`. */
  onSuccess?: (event: WebhookEvent, req: ExpressRequest) => unknown;
}

/**
 * Express webhook endpoint. The body must be raw bytes:
 *
 * ```ts
 * app.post("/api/webhooks", express.raw({ type: "application/json" }), orbit.webhookHandler(async (event) => {
 *   if (event.type === "user.created") await onUserCreated(event.data);
 * }));
 * ```
 *
 * Signatures are checked against a 5-minute timestamp tolerance, so a replay from an old delivery fails.
 */
export function webhookHandler(
  orbit: Pick<OrbitIdNode, "webhooks">,
  onEvent: (event: WebhookEvent, req: ExpressRequest) => void | Promise<void>,
  options: WebhookHandlerOptions = {},
): ExpressHandler {
  const reject = (error: unknown, req: ExpressRequest, res: ExpressResponse): void => {
    options.onError?.(error, req);
    writeError(res, 400, { errors: [{ code: "webhook_verification_failed", message: "The webhook payload could not be verified" }] });
  };

  return (req, res, next) => {
    void (async () => {
      const raw = req.body;
      if (!Buffer.isBuffer(raw) && typeof raw !== "string" && !(raw instanceof Uint8Array)) {
        reject(
          new OrbitIdError({
            code: "webhook_raw_body_missing",
            reason: "webhook-verification-failed",
            message: "Webhook handler needs the raw request body (express.raw({ type: 'application/json' }))",
          }),
          req,
          res,
        );
        return;
      }

      let event: WebhookEvent;
      try {
        event = await orbit.webhooks.verify<unknown>(raw, req.headers, options.secret) as WebhookEvent;
      } catch (error) {
        reject(error, req, res);
        return;
      }

      await onEvent(event, req);
      res.status(200).json(options.onSuccess ? options.onSuccess(event, req) : { received: true });
    })().catch(next);
  };
}

/**
 * Reads the caller of a plain `node:http` request.
 *
 * - `getAuth(req)` returns the value an adapter already attached (`req.auth`), synchronously.
 * - `getAuth(req, orbit)` verifies the request's token and returns the caller, or `null`.
 *
 * ```ts
 * const auth = await getAuth(req, orbit);
 * if (!auth) return send401(res);
 * ```
 */
export function getAuth(req: ExpressRequest): AuthContext | null;
export function getAuth(req: ExpressRequest, orbit: AuthResolver): Promise<AuthContext | null>;
export function getAuth(req: ExpressRequest, orbit?: AuthResolver): AuthContext | null | Promise<AuthContext | null> {
  if (orbit) return orbit.authenticate(toRequestLike(req));
  return req.auth ?? null;
}
