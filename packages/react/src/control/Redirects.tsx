import { useContext } from "react";
import { useAuth } from "../hooks/useAuth";
import { currentLocationUrl, resolveComponentUrl } from "../lib/redirects";
import { OrbitIDContext, OrbitIDOptionsContext } from "../provider/contexts";
import { useRedirect } from "./internal/useRedirect";

export interface RedirectToSignInProps {
  signInUrl?: string;
  /** Where to send the user after a successful sign-in. Defaults to the current URL. */
  redirectUrl?: string;
  /** Use `routerReplace` semantics (default `true`, avoids a back-button loop). */
  replace?: boolean;
}

/** Redirects signed-out users to the sign-in page; renders nothing. */
export function RedirectToSignIn({ signInUrl, redirectUrl, replace }: RedirectToSignInProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const instance = useContext(OrbitIDContext);
  const options = useContext(OrbitIDOptionsContext);

  useRedirect({
    when: isLoaded && !isSignedIn,
    replace,
    getTarget: () => {
      const target = redirectUrl ?? currentLocationUrl();
      const sdkUrl = instance?.buildSignInUrl?.({ redirectUrl: target });
      return resolveComponentUrl({
        component: "sign-in",
        url: signInUrl,
        configuredUrl: options.signInUrl,
        sdkUrl: sdkUrl ?? null,
        redirectUrl: target,
      });
    },
  });

  return null;
}

export interface RedirectToSignUpProps {
  signUpUrl?: string;
  redirectUrl?: string;
  replace?: boolean;
}

/** Redirects signed-out users to the sign-up page; renders nothing. */
export function RedirectToSignUp({ signUpUrl, redirectUrl, replace }: RedirectToSignUpProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const instance = useContext(OrbitIDContext);
  const options = useContext(OrbitIDOptionsContext);

  useRedirect({
    when: isLoaded && !isSignedIn,
    replace,
    getTarget: () => {
      const target = redirectUrl ?? currentLocationUrl();
      const sdkUrl = instance?.buildSignUpUrl?.({ redirectUrl: target });
      return resolveComponentUrl({
        component: "sign-up",
        url: signUpUrl,
        configuredUrl: options.signUpUrl,
        sdkUrl: sdkUrl ?? null,
        redirectUrl: target,
      });
    },
  });

  return null;
}

export interface RedirectToUserProfileProps {
  userProfileUrl?: string;
  replace?: boolean;
}

/** Redirects signed-in users to their profile page; renders nothing. */
export function RedirectToUserProfile({ userProfileUrl, replace }: RedirectToUserProfileProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const instance = useContext(OrbitIDContext);
  const options = useContext(OrbitIDOptionsContext);

  useRedirect({
    when: isLoaded && Boolean(isSignedIn),
    replace,
    getTarget: () =>
      resolveComponentUrl({
        component: "user-profile",
        url: userProfileUrl,
        configuredUrl: options.userProfileUrl,
        baseUrl: options.signInUrl ?? options.signUpUrl,
        sdkUrl: instance?.buildUserProfileUrl?.() ?? null,
      }),
  });

  return null;
}

export interface RedirectToOrganizationProfileProps {
  organizationProfileUrl?: string;
  replace?: boolean;
}

/** Redirects signed-in users to the organization profile page; renders nothing. */
export function RedirectToOrganizationProfile({ organizationProfileUrl, replace }: RedirectToOrganizationProfileProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const instance = useContext(OrbitIDContext);
  const options = useContext(OrbitIDOptionsContext);

  useRedirect({
    when: isLoaded && Boolean(isSignedIn),
    replace,
    getTarget: () =>
      resolveComponentUrl({
        component: "organization-profile",
        url: organizationProfileUrl,
        configuredUrl: options.organizationProfileUrl,
        baseUrl: options.signInUrl ?? options.signUpUrl,
        sdkUrl: instance?.buildOrganizationProfileUrl?.() ?? null,
      }),
  });

  return null;
}

export interface RedirectToCreateOrganizationProps {
  createOrganizationUrl?: string;
  replace?: boolean;
}

/** Redirects signed-in users to the create-organization page; renders nothing. */
export function RedirectToCreateOrganization({
  createOrganizationUrl,
  replace,
}: RedirectToCreateOrganizationProps) {
  const { isLoaded, isSignedIn } = useAuth();
  const instance = useContext(OrbitIDContext);
  const options = useContext(OrbitIDOptionsContext);

  useRedirect({
    when: isLoaded && Boolean(isSignedIn),
    replace,
    getTarget: () =>
      resolveComponentUrl({
        component: "create-organization",
        url: createOrganizationUrl,
        configuredUrl: options.createOrganizationUrl,
        baseUrl: options.signInUrl ?? options.signUpUrl,
        sdkUrl: instance?.buildCreateOrganizationUrl?.() ?? null,
      }),
  });

  return null;
}
