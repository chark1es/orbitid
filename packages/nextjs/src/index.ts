/**
 * `@orbitid/nextjs` — client-safe entry point.
 *
 * Re-exports the whole `@orbitid/react` surface (components, hooks, controls) plus the Next-aware
 * client provider. Server-only helpers live in `@orbitid/nextjs/server`.
 */
export * from "@orbitid/react";

export {
  ClientOrbitIDProvider,
  ClientOrbitIDProvider as OrbitIDProvider,
  HandshakeRefresher,
} from "./client-provider";
export type { ClientOrbitIDProviderProps } from "./client-provider";

export { AUTH_HEADERS, AUTH_REASONS, AUTH_STATUS } from "./auth-state";
export type {
  AuthObject,
  AuthStatus,
  InitialAuthState,
  ProtectParams,
  RequestAuthState,
} from "./auth-state";

export { buildAuthUrl, getPublicEnv, getPublishableKey } from "./env";
export type { PublicEnv } from "./env";
