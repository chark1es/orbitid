import { useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { OrbitIDContext, OrbitIDOptionsContext } from "../provider/contexts";
import type { OrbitIDInstance, RedirectCallbackParams } from "../provider/types";

export interface AuthenticateWithRedirectCallbackProps extends RedirectCallbackParams {
  children?: ReactNode;
}

/**
 * Landing point for OAuth / SSO / email-link redirects. Calls
 * `orbit.handleRedirectCallback(...)` once, merging provider-level fallback URLs.
 * Renders `children` immediately; throws if the SDK cannot complete the flow.
 */
export function AuthenticateWithRedirectCallback(props: AuthenticateWithRedirectCallbackProps) {
  const { children, ...params } = props;
  const instance = useContext(OrbitIDContext);
  const options = useContext(OrbitIDOptionsContext);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const startedRef = useRef(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const orbit: OrbitIDInstance | null = instance;
    if (!orbit?.handleRedirectCallback) {
      setError(
        new Error(
          "[OrbitID] AuthenticateWithRedirectCallback requires @orbitid/js to implement handleRedirectCallback().",
        ),
      );
      return;
    }
    const merged: RedirectCallbackParams = {
      signInFallbackRedirectUrl: optionsRef.current.signInFallbackRedirectUrl,
      signUpFallbackRedirectUrl: optionsRef.current.signUpFallbackRedirectUrl,
      signInForceRedirectUrl: optionsRef.current.signInForceRedirectUrl,
      signUpForceRedirectUrl: optionsRef.current.signUpForceRedirectUrl,
      ...paramsRef.current,
    };
    orbit.handleRedirectCallback(merged).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    });
  }, [instance]);

  if (error) throw error;
  return <>{children}</>;
}
