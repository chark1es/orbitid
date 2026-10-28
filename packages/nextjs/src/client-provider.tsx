"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  OrbitIDProvider as ReactOrbitIDProvider,
  useOrbitID,
  type OrbitIDProviderProps,
} from "@orbitid/react";
import type { InitialAuthState } from "./auth-state";
import { getPublicEnv } from "./env";

export type ClientOrbitIDProviderProps = Omit<
  OrbitIDProviderProps,
  "publishableKey" | "initialState" | "signInUrl" | "signUpUrl"
> & {
  publishableKey?: string;
  signInUrl?: string;
  signUpUrl?: string;
  /** Deprecated Clerk-compatible alias for `signInFallbackRedirectUrl`. */
  afterSignInUrl?: string;
  /** Deprecated Clerk-compatible alias for `signUpFallbackRedirectUrl`. */
  afterSignUpUrl?: string;
  /** Auth snapshot produced by the async provider in `@orbitid/nextjs/server`. */
  initialState?: InitialAuthState;
};

/**
 * Mounted by the server provider when middleware reported `handshake` (the browser has a client
 * but no fresh `__session`). Waits for the SDK to mint a token, then refreshes the RSC tree so
 * `auth()` sees it. Renders nothing.
 */
export function HandshakeRefresher({ enabled = true }: { enabled?: boolean }) {
  const orbit = useOrbitID();
  const router = useRouter();
  const refreshed = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || refreshed.current) return;
    let cancelled = false;

    const refreshWhenReady = async () => {
      if (cancelled || refreshed.current) return;
      let token: string | null = null;
      try {
        token = await orbit.session?.getToken?.() ?? null;
      } catch {
        token = null;
      }
      if (!token || cancelled || refreshed.current) return;
      refreshed.current = true;
      router.refresh();
    };

    void refreshWhenReady();
    const unsubscribe = orbit.addListener(() => {
      void refreshWhenReady();
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enabled, orbit, router]);

  return null;
}

/**
 * Client provider for `@orbitid/nextjs`. Reads `NEXT_PUBLIC_*` defaults, wires Next's router into
 * the SDK, and forwards the server-produced `initialState` for SSR hydration of `useAuth`.
 *
 * Use the async provider from `@orbitid/nextjs/server` in the App Router so `initialState` is filled
 * automatically; this component is also exported as `OrbitIDProvider` from the package root.
 */
export function ClientOrbitIDProvider({
  children,
  publishableKey,
  signInUrl,
  signUpUrl,
  afterSignInUrl,
  afterSignUpUrl,
  initialState,
  ...rest
}: ClientOrbitIDProviderProps) {
  const router = useRouter();
  const env = getPublicEnv({ publishableKey, signInUrl, signUpUrl, afterSignInUrl, afterSignUpUrl });

  const routerPush = React.useCallback((to: string) => router.push(to), [router]);
  const routerReplace = React.useCallback((to: string) => router.replace(to), [router]);

  return (
    <ReactOrbitIDProvider
      {...rest}
      publishableKey={env.publishableKey ?? ""}
      signInUrl={env.signInUrl}
      signUpUrl={env.signUpUrl}
      signInFallbackRedirectUrl={rest.signInFallbackRedirectUrl ?? env.afterSignInUrl}
      signUpFallbackRedirectUrl={rest.signUpFallbackRedirectUrl ?? env.afterSignUpUrl}
      routerPush={routerPush}
      routerReplace={routerReplace}
      initialState={initialState}
    >
      {children}
      {initialState?.status === "handshake" ? <HandshakeRefresher /> : null}
    </ReactOrbitIDProvider>
  );
}
