export { createOrbitId, ENV_KEYS, type CreateOrbitIdOptions, type OrbitIdNode, type ResolvedConfig, type WebhooksApi, type M2MApi, type ApiKeysApi } from "./client";
export { OrbitIdError, isOrbitIdError, parseApiErrorBody, errorFromResponse, type OrbitIdErrorReason, type OrbitIdErrorOptions } from "./errors";
export { JwksCache, type JwksCacheOptions } from "./jwks";
export { verifySessionToken, ALLOWED_ALGORITHMS, type VerifyTokenOptions, type TokenVerifierOptions } from "./token";
export { createTransport, type Transport, type TransportOptions } from "./transport";
export { authContextFromClaims, type AuthContext, type HasCheck } from "./auth-context";
export { readHeader, tokenFromRequest, isFetchRequest, headersOf, type RequestLike, type HeaderValue } from "./request";
export { SDK_VERSION, USER_AGENT } from "./version";

/** Framework adapters. Also available as methods on the `createOrbitId()` result. */
export {
  expressMiddleware,
  requireAuth,
  requirePermission,
  requireRole,
  webhookHandler,
  getAuth,
  type ExpressRequest,
  type ExpressResponse,
  type ExpressHandler,
  type ExpressNext,
  type ExpressMiddlewareOptions,
  type WebhookHandlerOptions,
} from "./adapters/express";
export {
  fastifyPlugin,
  fastifyRequireAuth,
  fastifyRequirePermission,
  fastifyRequireRole,
  type FastifyInstanceLike,
  type FastifyRequestLike,
  type FastifyReplyLike,
  type FastifyPluginOptions,
  type FastifyHook,
} from "./adapters/fastify";
export {
  honoMiddleware,
  honoRequireAuth,
  honoRequirePermission,
  honoRequireRole,
  type HonoContextLike,
  type HonoMiddleware,
  type HonoOptions,
  type OrbitIdHonoVariables,
} from "./adapters/hono";
export { type AdapterOptions, type AuthResolver, unauthorized, forbidden, authUnavailable } from "./adapters/shared";

export { COOKIES } from "@orbitid/shared";
export type { SessionClaims, WebhookEvent } from "@orbitid/shared";
export type { OrbitIdClient, ApiKey, M2MTokenVerification } from "@orbitid/backend";
