import * as React from "react";
import { initialAuthState } from "./server-auth";
import { ClientOrbitIDProvider, type ClientOrbitIDProviderProps } from "./client-provider";

export {
  auth,
  getAuth,
  initialAuthState,
  redirectToSignIn,
  redirectToSignUp,
  type AuthObject,
  type AuthStatus,
  type GetAuthInput,
  type InitialAuthState,
  type ProtectParams,
} from "./server-auth";

export { currentUser } from "./server-client";
export { orbitIdClient } from "./backend-client";

export {
  verifyWebhook,
  WebhookVerificationError,
  type WebhookRequestLike,
  type VerifyWebhookInput,
  type VerifyWebhookOptions,
} from "./webhooks";

export { orbitIdMiddleware } from "./middleware";
export type {
  ContentSecurityPolicy,
  ContentSecurityPolicyOptions,
  MiddlewareAuthObject,
  MiddlewareHandler,
  MiddlewareResult,
  OrbitIdMiddlewareOptions,
} from "./middleware";

export {
  HANDSHAKE_MARKER_COOKIE,
  buildHandshakeUrl,
  completeHandshake,
  isNavigationRequest,
  redirectToHandshake,
} from "./handshake";
export type { HandshakeOptions, HandshakeOutcome } from "./handshake";

export { compileRoutePattern, createRouteMatcher } from "./route-matcher";
export type {
  RouteMatcher,
  RouteMatcherParam,
  RouteMatcherPattern,
  RouteMatcherRequest,
} from "./route-matcher";

export type ServerOrbitIDProviderProps = ClientOrbitIDProviderProps & {
  children?: React.ReactNode;
};

/**
 * Server-component provider: reads `auth()` and hydrates the client provider, so `useAuth()` has
 * the right signed-in state on the first render instead of flashing signed-out.
 *
 * ```tsx
 * // app/layout.tsx
 * import { OrbitIDProvider } from '@orbitid/nextjs/server';
 *
 * export default function RootLayout({ children }: { children: React.ReactNode }) {
 *   return (
 *     <html lang="en">
 *       <body>
 *         <OrbitIDProvider>{children}</OrbitIDProvider>
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */
export async function OrbitIDProvider({
  children,
  ...props
}: ServerOrbitIDProviderProps): Promise<React.ReactElement> {
  const initialState = await initialAuthState();
  return React.createElement(ClientOrbitIDProvider, { ...props, initialState }, children);
}
