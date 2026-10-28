import { useEffect, useMemo, useReducer, useRef } from "react";
import type { OrbitIDInstance, SignInResource as SignInApi } from "../../../provider";
import { useOrbitID } from "../../../hooks";
import { useLocalizations } from "../../../localization";
import { enUS } from "../../../localization/enUS";
import { useAppearance, type ResolvedAppearance } from "../../../appearance";
import { normalizeEnvironment, type EnvironmentView } from "./environment";
import { enUS as authStrings, fallbackTranslate, interpolate, type TranslateParams } from "./strings";
import {
  invalidateNormalizedResources,
  normalizeClient,
  normalizeSession,
  normalizeSignIn,
  normalizeSignUp,
  normalizeUser,
  type NormalizedClient,
  type NormalizedSession,
  type NormalizedUser,
} from "./normalize";
import { isRecord } from "./guards";
import type { SignInResource, SignUpResource } from "./types";

export type OrbitInstance = OrbitIDInstance;
export type OrbitUser = NormalizedUser;
export type SignInApiResource = SignInApi;
export type { SignInApi };
export type { SignInFactorView } from "./types";
export type { NormalizedClient, NormalizedSession };
export type {
  NormalizedEmailAddress as EmailAddressResource,
  NormalizedExternalAccount as ExternalAccountResource,
  NormalizedPasskey as PasskeyResource,
  NormalizedPhoneNumber as PhoneNumberResource,
} from "./normalize";

export interface SignUpApi {
  [key: string]: unknown;
}

export interface AuthRouter {
  push(to: string): void;
  replace(to: string): void;
}

export type TranslateFn = (key: string, params?: TranslateParams) => string;

export interface AuthRuntime {
  orbit: OrbitInstance;
  environment: EnvironmentView;
  environmentLoaded: boolean;
  appearance: ResolvedAppearance;
  t: TranslateFn;
  router: AuthRouter;
  navigate(to: string, opts?: { replace?: boolean }): void;
  refresh(): void;
  loaded: boolean;
  user: OrbitUser | null;
  client: NormalizedClient | null;
  session: NormalizedSession | null;
  signIn: SignInResource | null;
  signUp: SignUpResource | null;
}

let fallbackInstalled = false;

/** Add the auth UI's strings to the active `enUS` resource for paths the provider does not define. */
function installFallbackKeys(): void {
  if (fallbackInstalled) return;
  fallbackInstalled = true;
  for (const [path, value] of Object.entries(authStrings)) {
    const segments = path.split(".");
    let target: Record<string, unknown> = enUS;
    for (const segment of segments.slice(0, -1)) {
      const existing = target[segment];
      if (!isRecord(existing)) {
        const created: Record<string, unknown> = {};
        target[segment] = created;
        target = created;
      } else {
        target = existing;
      }
    }
    const leaf = segments[segments.length - 1]!;
    if (target[leaf] === undefined) target[leaf] = value;
  }
}

function browserRouter(orbit: OrbitInstance): AuthRouter {
  const go = (to: string, replace: boolean) => {
    if (typeof orbit.navigate === "function") {
      orbit.navigate(to, { replace });
      return;
    }
    if (typeof window === "undefined") return;
    if (replace) window.location.replace(to);
    else window.location.assign(to);
  };
  return {
    push: (to) => go(to, false),
    replace: (to) => go(to, true),
  };
}

export function useAuthRuntime(): AuthRuntime {
  const orbit = useOrbitID();
  const resolvedAppearance = useAppearance();
  const { t: providerT } = useLocalizations();
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    installFallbackKeys();
    if (typeof orbit.addListener !== "function") return;
    const unsubscribe = orbit.addListener(() => {
      invalidateNormalizedResources();
      forceRender();
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [orbit]);

  const environment = useMemo(
    () =>
      normalizeEnvironment(orbit.environment, {
        developmentMode: typeof orbit.isDevelopmentMode === "boolean" ? orbit.isDevelopmentMode : undefined,
      }),
    [orbit.environment, orbit.isDevelopmentMode],
  );

  const t = useMemo<TranslateFn>(() => {
    return (key, params) => {
      const translated = providerT?.(key, params);
      if (typeof translated === "string" && translated !== key) return interpolate(translated, params);
      return fallbackTranslate(key, params) ?? key;
    };
  }, [providerT]);

  const router = useMemo(() => browserRouter(orbit), [orbit]);

  const refreshRef = useRef(forceRender);
  refreshRef.current = forceRender;

  return {
    orbit,
    environment,
    environmentLoaded: Boolean(orbit.environment),
    appearance: resolvedAppearance,
    t,
    router,
    navigate: (to, opts) => (opts?.replace ? router.replace(to) : router.push(to)),
    refresh: () => {
      invalidateNormalizedResources();
      refreshRef.current();
    },
    loaded: Boolean(orbit.loaded),
    user: normalizeUser(orbit.user),
    client: normalizeClient(orbit.client),
    session: normalizeSession(orbit.session),
    signIn: normalizeSignIn(orbit.signIn ?? orbit.client?.signIn),
    signUp: normalizeSignUp(orbit.signUp ?? orbit.client?.signUp),
  };
}

export { isRecord } from "./guards";
