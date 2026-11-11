import type { FetchLike } from "../fapi";
import type { Client } from "../resources/client";
import type { Environment } from "../resources/environment";
import type { Organization } from "../resources/organization";
import type { Session } from "../resources/session";
import type { SignIn } from "../resources/sign-in";
import type { SignUp } from "../resources/sign-up";
import type { User } from "../resources/user";
import type { CookieOptions } from "../util/cookies";

export type RouterFn = (url: string) => void;

export interface OrbitIDNavigateOptions {
  push?: RouterFn;
  replace?: RouterFn;
}

export interface OrbitIDOptions {
  /** Frontend API domain (`auth.example.com`) when not using the publishable key's encoded URL. */
  domain?: string;
  /** Reverse-proxy base URL (`https://app.example.com/__orbit`). */
  proxyUrl?: string;
  /** Explicit Frontend API URL (local development/tests). */
  frontendApi?: string;
  fetch?: FetchLike;
  signInUrl?: string;
  signUpUrl?: string;
  userProfileUrl?: string;
  createOrganizationUrl?: string;
  organizationProfileUrl?: string;
  waitlistUrl?: string;
  afterSignInUrl?: string;
  afterSignUpUrl?: string;
  afterSignOutUrl?: string;
  navigate?: OrbitIDNavigateOptions;
  routerPush?: RouterFn;
  routerReplace?: RouterFn;
  cookie?: Pick<CookieOptions, "domain" | "secure">;
  retry?: { attempts?: number; delayMs?: number };
  /**
   * Fixed session-token refresh cadence, in ms. Leave unset (recommended): the SDK schedules the next refresh
   * from the token's own `exp` and re-arms after suspend/offline, which is what keeps a JWT fresh in a
   * throttled background tab. Set this only to force a cadence.
   */
  tokenRefreshIntervalMs?: number;
}

export interface OrbitIDState {
  client: Client | null;
  session: Session | null;
  user: User | null;
  organization: Organization | null;
}

export type OrbitIDListener = (state: OrbitIDState) => void;

export interface SetActiveParams {
  session?: string | null;
  organization?: string | Organization | null;
  beforeEmit?: (state: OrbitIDState) => void | Promise<void>;
  redirectUrl?: string;
}

export interface SetActiveResult {
  session: Session | null;
}

export interface HandleRedirectCallbackParams {
  signInForceRedirectUrl?: string;
  signInFallbackRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
  signUpFallbackRedirectUrl?: string;
  firstFactorUrl?: string;
  secondFactorUrl?: string;
  resetPasswordUrl?: string;
  continueSignInUrl?: string;
  continueSignUpUrl?: string;
}

export interface HandleRedirectCallbackResult {
  signIn: SignIn | null;
  signUp: SignUp | null;
}
