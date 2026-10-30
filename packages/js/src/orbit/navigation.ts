import { appendQuery, buildRedirectUrl } from "../util/url";
import { inBrowser } from "../util/browser";
import type { OrbitIDOptions } from "./types";

/**
 * A navigation target: an absolute http(s) URL or a relative path.
 *
 * A `javascript:`/`data:` target would execute or render attacker content in this tab, and `//host` is a
 * protocol-relative URL that silently leaves the app. Both are refused; a relative path is fine because it
 * stays on this origin.
 */
export function isNavigationTarget(to: string): boolean {
  if (!to || /[\u0000-\u001f\u007f\\]/.test(to)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(to)) {
    if (!/^https?:\/\//i.test(to)) return false;
    try {
      const parsed = new URL(to);
      return !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }
  return !to.startsWith("//");
}

/**
 * Navigates with the app-provided router when available, otherwise with `window.location`.
 * Every target can come from app configuration or a `redirectUrl` parameter, so anything that is not
 * http(s) or a root-relative path is refused: `window.location.assign("javascript:…")` executes, and
 * `//evil.test` leaves the app. Same-origin is *not* required — pointing at another host is a valid
 * deployment (a separate accounts site), and this is not the token-handoff path.
 */
export function navigate(options: OrbitIDOptions, to: string, navOptions: { replace?: boolean } = {}): void {
  if (!isNavigationTarget(to)) return;
  const push = options.navigate?.push ?? options.routerPush;
  const replace = options.navigate?.replace ?? options.routerReplace;
  if (navOptions.replace && replace) {
    replace(to);
    return;
  }
  if (push) {
    push(to);
    return;
  }
  if (inBrowser) {
    if (navOptions.replace) window.location.replace(to);
    else window.location.assign(to);
  }
}

export function buildSignInUrl(options: OrbitIDOptions, params: { redirectUrl?: string } = {}): string {
  return buildRedirectUrl(options.signInUrl ?? "/sign-in", params.redirectUrl ?? options.afterSignInUrl);
}

export function buildSignUpUrl(options: OrbitIDOptions, params: { redirectUrl?: string } = {}): string {
  return buildRedirectUrl(options.signUpUrl ?? "/sign-up", params.redirectUrl ?? options.afterSignUpUrl);
}

export function buildUserProfileUrl(options: OrbitIDOptions, params: { redirectUrl?: string } = {}): string {
  return buildRedirectUrl(options.userProfileUrl ?? "/user", params.redirectUrl);
}

export function buildCreateOrganizationUrl(options: OrbitIDOptions): string {
  return options.createOrganizationUrl ?? "/create-organization";
}

export function buildOrganizationProfileUrl(options: OrbitIDOptions, params: { organizationId?: string } = {}): string {
  const base = options.organizationProfileUrl ?? "/organization";
  return params.organizationId ? appendQuery(base, { organization_id: params.organizationId }) : base;
}

export function buildWaitlistUrl(options: OrbitIDOptions): string {
  return options.waitlistUrl ?? "/waitlist";
}

export function buildAfterSignInUrl(options: OrbitIDOptions): string {
  return options.afterSignInUrl ?? "/";
}

export function buildAfterSignUpUrl(options: OrbitIDOptions): string {
  return options.afterSignUpUrl ?? "/";
}

export function buildAfterSignOutUrl(options: OrbitIDOptions): string {
  return options.afterSignOutUrl ?? "/";
}
