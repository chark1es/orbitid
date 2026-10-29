import {
  createOrbitIdClient,
  type ApiKey,
  type BackendFetch,
  type M2MTokenVerification,
  type OrbitIdClient,
} from "@orbitid/backend";
import { verifyWebhook as verifyWebhookSignature } from "@orbitid/backend/webhooks";
import { isPublishableKey, decodePublishableKey, type SessionClaims, type WebhookEvent } from "@orbitid/shared";
import { authContextFromClaims, type AuthContext } from "./auth-context";
import { OrbitIdError, isOrbitIdError } from "./errors";
import { JwksCache } from "./jwks";
import { tokenFromRequest, type HeaderLike, type RequestLike } from "./request";
import { verifySessionToken } from "./token";
import { createTransport, type Transport } from "./transport";
import { SDK_VERSION } from "./version";
import * as express from "./adapters/express";
import * as fastify from "./adapters/fastify";
import * as hono from "./adapters/hono";

/** Environment variables read when the matching option is omitted. */
export const ENV_KEYS = {
  secretKey: "ORBITID_SECRET_KEY",
  apiUrl: "ORBITID_API_URL",
  jwksUrl: "ORBITID_JWKS_URL",
  publishableKey: "ORBITID_PUBLISHABLE_KEY",
  audience: "ORBITID_AUDIENCE",
  issuer: "ORBITID_ISSUER",
  webhookSecret: "ORBITID_WEBHOOK_SECRET",
} as const;

export interface CreateOrbitIdOptions {
  /**
   * Backend API secret (`sk_test_…` / `sk_live_…`). Required; falls back to `ORBITID_SECRET_KEY`.
   * It is never logged, never echoed in an error and never returned by this SDK.
   */
  secretKey?: string;
  /** Base URL of the OrbitID server, as this process reaches it. `ORBITID_API_URL`, else read from the publishable key. Required. */
  apiUrl?: string;
  /**
   * The server's public URL, which is what tokens carry as `iss`. Defaults to the URL in the publishable key, else
   * `apiUrl`. Set it when your process reaches the server on an internal address (`http://orbitid:4000`) but tokens are
   * issued for the public one (`https://auth.example.com`). `ORBITID_ISSUER`.
   */
  issuer?: string;
  /** JWKS endpoint. Defaults to `${apiUrl}/.well-known/jwks.json`; `ORBITID_JWKS_URL` overrides. */
  jwksUrl?: string;
  /** Publishable key (`pk_test_…`). Only used to derive the API URL when `apiUrl` is not set. */
  publishableKey?: string;
  /** Expected `aud` claim. Leave unset for session tokens, which carry no audience. */
  audience?: string | string[];
  /** Clock skew allowed for `exp`/`nbf`, in seconds. Defaults to 5. */
  clockToleranceSeconds?: number;
  /** Accepted `azp` values (your app origins). */
  authorizedParties?: string[];
  /** Webhook signing secret (`whsec_…`) used by `webhooks.verify`. `ORBITID_WEBHOOK_SECRET`. */
  webhookSecret?: string;
  /** Transport override; defaults to the global `fetch`. */
  fetch?: BackendFetch;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
  /** Extra attempts for idempotent GETs. Defaults to 2. */
  retries?: number;
  /** Base backoff between GET retries, in milliseconds. Defaults to 150. */
  retryDelayMs?: number;
  /** JWKS document lifetime, in milliseconds. Defaults to 600_000. */
  jwksMaxAgeMs?: number;
  /** Minimum gap between JWKS re-fetches triggered by an unknown `kid`, in milliseconds. Defaults to 30_000. */
  jwksCooldownMs?: number;
}

export interface WebhooksApi {
  /**
   * Verifies a Svix-compatible delivery: `svix-id`, `svix-timestamp`, `svix-signature`.
   * Pass the raw body bytes (`express.raw({ type: "application/json" })`), never the parsed JSON.
   */
  verify<T = unknown>(rawBody: string | Uint8Array, headers: HeaderLike, secret?: string): Promise<WebhookEvent<T>>;
}

export interface M2MApi {
  /** Verifies a machine token (`mt_…` or a JWT) with `POST /v1/m2m/tokens/verify`. */
  verify(token: string): Promise<M2MTokenVerification>;
}

export interface ApiKeysApi {
  /** Verifies an API key (`ak_live_…`) with `POST /v1/api_keys/verify`. */
  verify(key: string): Promise<ApiKey>;
}

/** Non-secret configuration, safe to log. */
export interface ResolvedConfig {
  apiUrl: string;
  jwksUrl: string;
  issuer: string;
  audience: string | string[] | undefined;
  clockToleranceSeconds: number;
}

export interface OrbitIdNode {
  /** Typed Backend API client (`users`, `organizations`, `sessions`, …). */
  readonly client: OrbitIdClient;
  /** Verifies a session JWT and returns its claims. Throws `OrbitIdError` on failure. */
  verifyToken(token: string): Promise<SessionClaims>;
  /**
   * Resolves the caller of a Node `IncomingMessage` or a Fetch `Request`.
   * Returns `null` when the request carries no usable session (missing, expired, invalid, pending);
   * throws `OrbitIdError` when verification itself could not run (for example the JWKS is unreachable).
   */
  authenticate(request: RequestLike): Promise<AuthContext | null>;
  webhooks: WebhooksApi;
  m2m: M2MApi;
  apiKeys: ApiKeysApi;
  /** Express/`node:http` middleware: sets `req.auth`, continues either way. */
  expressMiddleware(options?: express.ExpressMiddlewareOptions): express.ExpressHandler;
  /** Express/`node:http` middleware: 401 unless signed in. */
  requireAuth(options?: express.ExpressMiddlewareOptions): express.ExpressHandler;
  /** Express/`node:http` middleware: 401 when signed out, 403 when the permission is missing. */
  requirePermission(permission: string | string[], options?: express.ExpressMiddlewareOptions): express.ExpressHandler;
  /** Express/`node:http` middleware: 401 when signed out, 403 when the role does not match. */
  requireRole(role: string | string[], options?: express.ExpressMiddlewareOptions): express.ExpressHandler;
  /** Express webhook endpoint; needs the raw body (`express.raw({ type: "application/json" })`). */
  webhookHandler(
    onEvent: (event: WebhookEvent, req: express.ExpressRequest) => void | Promise<void>,
    options?: express.WebhookHandlerOptions,
  ): express.ExpressHandler;
  /** Fastify plugin: `fastify.decorateRequest("auth")` + a `preHandler` that fills it in. */
  fastifyPlugin(options?: fastify.FastifyPluginOptions): (instance: fastify.FastifyInstanceLike, opts: unknown, done: (error?: Error) => void) => void;
  fastifyRequireAuth(options?: fastify.FastifyPluginOptions): fastify.FastifyHook;
  fastifyRequirePermission(permission: string | string[], options?: fastify.FastifyPluginOptions): fastify.FastifyHook;
  fastifyRequireRole(role: string | string[], options?: fastify.FastifyPluginOptions): fastify.FastifyHook;
  /** Hono middleware: sets `c.get("auth")` and continues. */
  honoMiddleware(options?: hono.HonoOptions): hono.HonoMiddleware;
  honoRequireAuth(options?: hono.HonoOptions): hono.HonoMiddleware;
  honoRequirePermission(permission: string | string[], options?: hono.HonoOptions): hono.HonoMiddleware;
  honoRequireRole(role: string | string[], options?: hono.HonoOptions): hono.HonoMiddleware;
  /** Non-secret, resolved settings. */
  readonly config: ResolvedConfig;
  readonly version: string;
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const value = process.env[name];
  return value?.trim() || undefined;
}

function configurationError(message: string, code = "configuration_invalid"): OrbitIdError {
  return new OrbitIdError({ code, reason: "configuration", message });
}

/** The secret key is required: an unauthenticated SDK would fail every call at runtime instead. */
function resolveSecretKey(options: CreateOrbitIdOptions): string {
  const value = options.secretKey ?? readEnv(ENV_KEYS.secretKey);
  if (!value) {
    throw configurationError(
      "No secret key provided. Pass `secretKey` to createOrbitId() or set ORBITID_SECRET_KEY " +
        "(Dashboard → API keys, or the value derived from ORBITID_ENCRYPTION_KEY).",
      "secret_key_missing",
    );
  }
  if (/[\r\n]/.test(value)) throw configurationError("The secret key must not contain line breaks", "secret_key_invalid");
  const secretKey = value.trim();
  if (!/^sk_(test|live)_[A-Za-z0-9_-]{8,}$/.test(secretKey)) {
    throw configurationError(
      'The secret key does not look like an OrbitID secret key (expected "sk_test_…" or "sk_live_…"). ' +
        "A publishable key (pk_…) belongs in the browser, not here.",
      "secret_key_invalid",
    );
  }
  return secretKey;
}

function resolveApiUrl(options: CreateOrbitIdOptions): string | undefined {
  const explicit = options.apiUrl ?? readEnv(ENV_KEYS.apiUrl);
  if (explicit) return explicit.replace(/\/+$/, "");
  const publishableKey = options.publishableKey ?? readEnv(ENV_KEYS.publishableKey);
  if (publishableKey && isPublishableKey(publishableKey)) {
    try {
      return decodePublishableKey(publishableKey).frontendApi.replace(/\/+$/, "");
    } catch (error) {
      throw new OrbitIdError({ code: "configuration_invalid", reason: "configuration", message: "The OrbitID publishable key is malformed", cause: error });
    }
  }
  return undefined;
}

function resolveIssuer(options: CreateOrbitIdOptions, apiUrl: string): string {
  const explicit = options.issuer ?? readEnv(ENV_KEYS.issuer);
  if (explicit) return explicit.replace(/\/+$/, "");
  const publishableKey = options.publishableKey ?? readEnv(ENV_KEYS.publishableKey);
  if (publishableKey && isPublishableKey(publishableKey)) {
    try {
      return decodePublishableKey(publishableKey).frontendApi.replace(/\/+$/, "");
    } catch {
      /* a malformed key was already reported while resolving the API URL */
    }
  }
  return apiUrl;
}

function resolveJwksUrl(options: CreateOrbitIdOptions, apiUrl: string): string {
  const explicit = options.jwksUrl ?? readEnv(ENV_KEYS.jwksUrl);
  if (explicit) return explicit;
  return `${apiUrl.replace(/\/+$/, "")}/.well-known/jwks.json`;
}

function normalizeAudience(value: string | string[] | undefined): string | string[] | undefined {
  if (value === undefined) return undefined;
  const list = (Array.isArray(value) ? value : value.split(",")).map((entry) => entry.trim()).filter(Boolean);
  if (!list.length) return undefined;
  return Array.isArray(value) ? list : list.length === 1 ? list[0] : list;
}

/** Reasons that mean "this request is not signed in" rather than "verification is broken". */
const SIGNED_OUT_REASONS = new Set([
  "token-missing",
  "token-expired",
  "token-not-active-yet",
  "invalid-signature",
  "invalid-algorithm",
  "invalid-issuer",
  "invalid-audience",
  "invalid-authorized-party",
  "invalid-claims",
  "not-session-token",
  "session-pending",
  "no-matching-key",
]);

/**
 * Creates the batteries-included Node SDK: Backend API client, offline session verification,
 * request authentication, webhook verification and machine/API-key helpers.
 *
 * ```ts
 * const orbit = createOrbitId();           // reads ORBITID_SECRET_KEY and ORBITID_API_URL
 * const auth = await orbit.authenticate(req);
 * ```
 */
export function createOrbitId(options: CreateOrbitIdOptions = {}): OrbitIdNode {
  const secretKey = resolveSecretKey(options);
  const resolvedApiUrl = resolveApiUrl(options);
  // There is no hosted OrbitID to fall back to, and the secret key must never go anywhere the operator did not name.
  if (!resolvedApiUrl) {
    throw new OrbitIdError({
      code: "configuration_invalid",
      reason: "configuration",
      message: "Set ORBITID_API_URL (or the apiUrl option) to the URL of your OrbitID server, or supply a publishable key it can be read from",
    });
  }
  const transport: Transport = createTransport({
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
  });

  const client = createOrbitIdClient({
    secretKey,
    apiUrl: resolvedApiUrl,
    fetch: transport.request,
  });

  const audience = normalizeAudience(options.audience ?? readEnv(ENV_KEYS.audience));
  const clockToleranceSeconds = options.clockToleranceSeconds ?? 5;
  const issuer = resolveIssuer(options, client.apiUrl);
  // Keys are fetched from where this process reaches the server, whatever the public issuer is.
  const jwksUrl = resolveJwksUrl(options, client.apiUrl);
  const jwks = new JwksCache({
    url: jwksUrl,
    fetch: transport.fetch,
    maxAgeMs: options.jwksMaxAgeMs,
    cooldownMs: options.jwksCooldownMs,
  });
  const verifier = {
    issuer,
    audience,
    authorizedParties: options.authorizedParties,
    clockToleranceSeconds,
    jwks,
  };

  const verifyToken = (token: string): Promise<SessionClaims> => verifySessionToken({ token }, verifier);

  const authenticate = async (request: RequestLike): Promise<AuthContext | null> => {
    if (!request || typeof request !== "object") return null;
    const token = tokenFromRequest(request);
    if (!token) return null;
    try {
      return authContextFromClaims(await verifyToken(token));
    } catch (error) {
      if (isOrbitIdError(error) && error.reason && SIGNED_OUT_REASONS.has(error.reason)) return null;
      throw error;
    }
  };

  const webhookSecret = options.webhookSecret ?? readEnv(ENV_KEYS.webhookSecret);

  const webhooks: WebhooksApi = {
    async verify<T = unknown>(rawBody: string | Uint8Array, headers: HeaderLike, secret?: string) {
      const signingSecret = secret ?? webhookSecret;
      if (!signingSecret) {
        throw configurationError(
          "No webhook secret provided. Pass it to createOrbitId({ webhookSecret }) or set ORBITID_WEBHOOK_SECRET.",
          "webhook_secret_missing",
        );
      }
      const body = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
      // `verifyWebhook` returns the event; verification failures are mapped to the SDK's error type.
      try {
        return await verifyWebhookSignature<T>({ body, headers: headers as Record<string, string | undefined> }, { signingSecret, toleranceInSeconds: 300 });
      } catch (error) {
        throw new OrbitIdError({
          status: 400,
          code: "webhook_verification_failed",
          reason: "webhook-verification-failed",
          message: "The webhook payload could not be verified",
          cause: error,
        });
      }
    },
  };

  const m2m: M2MApi = {
    verify: (token: string) => client.m2m.tokens.verifyToken({ token }),
  };
  const apiKeys: ApiKeysApi = {
    verify: (key: string) => client.apiKeys.verifyApiKey({ secret: key }),
  };

  const sdk: OrbitIdNode = {
    client,
    verifyToken,
    authenticate,
    webhooks,
    m2m,
    apiKeys,
    expressMiddleware: (adapterOptions) => express.expressMiddleware(sdk, adapterOptions),
    requireAuth: (adapterOptions) => express.requireAuth(sdk, adapterOptions),
    requirePermission: (permission, adapterOptions) => express.requirePermission(sdk, permission, adapterOptions),
    requireRole: (role, adapterOptions) => express.requireRole(sdk, role, adapterOptions),
    webhookHandler: (onEvent, adapterOptions) => express.webhookHandler(sdk, onEvent, adapterOptions),
    fastifyPlugin: (adapterOptions) => fastify.fastifyPlugin(sdk, adapterOptions),
    fastifyRequireAuth: (adapterOptions) => fastify.fastifyRequireAuth(sdk, adapterOptions),
    fastifyRequirePermission: (permission, adapterOptions) => fastify.fastifyRequirePermission(sdk, permission, adapterOptions),
    fastifyRequireRole: (role, adapterOptions) => fastify.fastifyRequireRole(sdk, role, adapterOptions),
    honoMiddleware: (adapterOptions) => hono.honoMiddleware(sdk, adapterOptions),
    honoRequireAuth: (adapterOptions) => hono.honoRequireAuth(sdk, adapterOptions),
    honoRequirePermission: (permission, adapterOptions) => hono.honoRequirePermission(sdk, permission, adapterOptions),
    honoRequireRole: (role, adapterOptions) => hono.honoRequireRole(sdk, role, adapterOptions),
    config: { apiUrl: client.apiUrl, jwksUrl, issuer, audience, clockToleranceSeconds },
    version: SDK_VERSION,
  };
  return sdk;
}

/** Exported for adapters and tests: header helpers used across the SDK. */
export { tokenFromRequest } from "./request";
export type { RequestLike } from "./request";
