import { useContext, useEffect, useRef } from "react";
import { OrbitIDContext, OrbitIDOptionsContext } from "../../provider/contexts";
import type { OrbitIDInstance } from "../../provider/types";

export interface NavigateOptions {
  replace?: boolean;
  routerPush?: (to: string) => void | Promise<unknown>;
  routerReplace?: (to: string) => void | Promise<unknown>;
}

/**
 * Client-side navigation with the same precedence the SDK uses:
 * `orbit.navigate()` → provider `routerPush`/`routerReplace` → `window.location`.
 * No-op during SSR.
 */
export function navigateTo(url: string, options: NavigateOptions, instance: OrbitIDInstance | null): void {
  if (!url || typeof window === "undefined") return;
  if (instance?.navigate) {
    instance.navigate(url, { replace: options.replace });
    return;
  }
  if (options.replace) {
    if (options.routerReplace) {
      void options.routerReplace(url);
      return;
    }
    window.location.replace(url);
    return;
  }
  if (options.routerPush) {
    void options.routerPush(url);
    return;
  }
  window.location.assign(url);
}

export interface UseRedirectOptions {
  /** Navigate only when this is true (typically `isLoaded && !isSignedIn`). */
  when: boolean;
  /** Computed lazily, so props are always current. */
  getTarget: () => string | null;
  replace?: boolean;
}

/**
 * Fire-once redirect for the `RedirectToSignIn`/`RedirectToUserProfile` components. The ref
 * guard makes it safe under StrictMode double effects (one navigation, not two).
 */
export function useRedirect({ when, getTarget, replace = true }: UseRedirectOptions): null {
  const instance = useContext(OrbitIDContext);
  const { routerPush, routerReplace } = useContext(OrbitIDOptionsContext);
  const targetRef = useRef(getTarget);
  targetRef.current = getTarget;
  const doneRef = useRef(false);

  useEffect(() => {
    if (!when || doneRef.current) return;
    const url = targetRef.current();
    if (!url) return;
    doneRef.current = true;
    navigateTo(url, { replace, routerPush, routerReplace }, instance);
  }, [when, replace, instance, routerPush, routerReplace]);

  return null;
}
