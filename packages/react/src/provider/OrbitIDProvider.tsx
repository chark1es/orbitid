import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { resolveAppearance } from "../appearance/resolve";
import { canUseDOM } from "../lib/canUseDOM";
import { enUS } from "../localization/enUS";
import { createTranslator, mergeLocalization } from "../localization/translate";
import type { LocalizationContextValue } from "../localization/types";
import { buildSnapshot, createAuthState } from "./auth";
import {
  AppearanceContext,
  AuthContext,
  ClientContext,
  LocalizationContext,
  OrbitIDContext,
  OrbitIDOptionsContext,
  OrganizationContext,
  SessionContext,
  StatusContext,
  UserContext,
} from "./contexts";
import { createServerOrbitID, getInstanceStore, getOrbitIDInstance, loadOrbitID } from "./instance";
import { createReverificationUI, ReverificationContext } from "./reverification";
import type {
  OrbitIDInstance,
  OrbitIDOptions,
  OrbitIDOptionsContextValue,
  OrbitIDProviderProps,
  OrbitIDStatus,
  OrbitIDStatusContextValue,
} from "./types";
import { useSessionClaims } from "./useSessionClaims";

/**
 * Creates (once), loads and subscribes to the `@orbitid/js` instance, then publishes every
 * context the components/hooks consume.
 *
 * SSR: no `window` access at render; `initialState` drives the first (server + hydration)
 * render. StrictMode: instance creation and `load()` are deduped, so double-mounted effects
 * do not create a second client.
 */
export function OrbitIDProvider(props: OrbitIDProviderProps) {
  const {
    children,
    publishableKey,
    orbit,
    initialState,
    appearance,
    localization,
    routerPush,
    routerReplace,
    signInUrl,
    signUpUrl,
    userProfileUrl,
    organizationProfileUrl,
    createOrganizationUrl,
    signInFallbackRedirectUrl,
    signUpFallbackRedirectUrl,
    signInForceRedirectUrl,
    signUpForceRedirectUrl,
    afterSignOutUrl,
    allowedRedirectOrigins,
  } = props;

  if (!publishableKey && !orbit) {
    throw new Error("[OrbitID] <OrbitIDProvider/> requires a `publishableKey` (or a pre-built `orbit` instance).");
  }

  const instanceOptions = useMemo<OrbitIDOptions>(
    () => ({
      routerPush,
      routerReplace,
      signInUrl,
      signUpUrl,
      userProfileUrl,
      organizationProfileUrl,
      createOrganizationUrl,
      afterSignOutUrl,
    }),
    [
      routerPush,
      routerReplace,
      signInUrl,
      signUpUrl,
      userProfileUrl,
      organizationProfileUrl,
      createOrganizationUrl,
      afterSignOutUrl,
    ],
  );

  const instance = useMemo<OrbitIDInstance>(
    () =>
      orbit ??
      (canUseDOM()
        ? getOrbitIDInstance(publishableKey, instanceOptions)
        : createServerOrbitID(publishableKey, instanceOptions)),
    [orbit, publishableKey, instanceOptions],
  );

  const store = useMemo(() => getInstanceStore(instance), [instance]);
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot, () => 0);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((previous) => previous + 1), []);
  const [status, setStatus] = useState<{ status: OrbitIDStatus; error: Error | null }>(() =>
    initialState || orbit?.loaded ? { status: "ready", error: null } : { status: "loading", error: null },
  );

  useEffect(() => {
    if (instance.loaded) {
      setStatus({ status: "ready", error: null });
      return;
    }
    let cancelled = false;
    setStatus({ status: "loading", error: null });
    loadOrbitID(instance).then(
      () => {
        if (!cancelled) setStatus({ status: "ready", error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setStatus({ status: "error", error: error instanceof Error ? error : new Error(String(error)) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [instance, attempt]);

  const snapshot = useMemo(() => buildSnapshot(instance, initialState), [instance, initialState, version]);

  const claims = useSessionClaims({
    instance,
    session: snapshot.session,
    organization: snapshot.organization,
    initialStateClaims: initialState?.sessionClaims,
    version,
  });

  const authState = useMemo(
    () =>
      createAuthState({
        loaded: snapshot.loaded,
        session: snapshot.session,
        user: snapshot.user,
        organization: snapshot.organization,
        claims,
        initialState,
        instance,
        afterSignOutUrl,
      }),
    [snapshot, claims, initialState, instance, afterSignOutUrl],
  );

  const resolvedAppearance = useMemo(() => resolveAppearance(appearance), [appearance]);

  const localizations = useMemo<LocalizationContextValue>(() => {
    if (localization === false) {
      return { locale: enUS.locale ?? "en-US", resource: enUS, t: createTranslator(enUS) };
    }
    const resource = localization ? mergeLocalization(enUS, localization) : enUS;
    return { locale: resource.locale ?? "en-US", resource, t: createTranslator(resource) };
  }, [localization]);

  const reverification = useMemo(() => createReverificationUI(), []);

  const optionsValue = useMemo<OrbitIDOptionsContextValue>(
    () => ({
      publishableKey,
      instance,
      initialState,
      appearance,
      localization,
      routerPush,
      routerReplace,
      signInUrl,
      signUpUrl,
      userProfileUrl,
      organizationProfileUrl,
      createOrganizationUrl,
      signInFallbackRedirectUrl,
      signUpFallbackRedirectUrl,
      signInForceRedirectUrl,
      signUpForceRedirectUrl,
      afterSignOutUrl,
      allowedRedirectOrigins,
    }),
    [
      publishableKey,
      instance,
      initialState,
      appearance,
      localization,
      routerPush,
      routerReplace,
      signInUrl,
      signUpUrl,
      userProfileUrl,
      organizationProfileUrl,
      createOrganizationUrl,
      signInFallbackRedirectUrl,
      signUpFallbackRedirectUrl,
      signInForceRedirectUrl,
      signUpForceRedirectUrl,
      afterSignOutUrl,
      allowedRedirectOrigins,
    ],
  );

  const statusValue = useMemo<OrbitIDStatusContextValue>(
    () => ({ ...status, retry }),
    [status, retry],
  );

  // CSS custom properties are valid style keys, but `CSSProperties` has no index signature.
  const rootStyle = resolvedAppearance.cssVariables as CSSProperties;

  return (
    <OrbitIDContext.Provider value={instance}>
      <OrbitIDOptionsContext.Provider value={optionsValue}>
        <StatusContext.Provider value={statusValue}>
          <AppearanceContext.Provider value={resolvedAppearance}>
            <LocalizationContext.Provider value={localizations}>
              <ReverificationContext.Provider value={reverification}>
                <ClientContext.Provider value={snapshot.client}>
                  <SessionContext.Provider value={snapshot.session}>
                    <UserContext.Provider value={snapshot.user}>
                      <OrganizationContext.Provider value={snapshot.organization}>
                        <AuthContext.Provider value={authState}>
                          <div
                            className={resolvedAppearance.rootClassName}
                            style={rootStyle}
                            data-orbitid-theme={resolvedAppearance.theme.name}
                          >
                            {children}
                          </div>
                        </AuthContext.Provider>
                      </OrganizationContext.Provider>
                    </UserContext.Provider>
                  </SessionContext.Provider>
                </ClientContext.Provider>
              </ReverificationContext.Provider>
            </LocalizationContext.Provider>
          </AppearanceContext.Provider>
        </StatusContext.Provider>
      </OrbitIDOptionsContext.Provider>
    </OrbitIDContext.Provider>
  );
}
