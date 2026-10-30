import { appendQuery } from "../util/url";
import type { Client } from "../resources/client";
import type { SignUp } from "../resources/sign-up";
import type {
  HandleRedirectCallbackParams,
  HandleRedirectCallbackResult,
  OrbitIDOptions,
  SetActiveParams,
  SetActiveResult,
} from "./types";

export interface RedirectCallbackContext {
  readonly options: OrbitIDOptions;
  client(): Client | null;
  /** The always-usable sign-up resource (mirrors the `OrbitID.signUp` getter). */
  signUp(): SignUp;
  refreshClient(): Promise<Client | null>;
  setActive(params: SetActiveParams): Promise<SetActiveResult>;
  navigate(to: string, options?: { replace?: boolean }): void;
}

/**
 * Handles the OAuth/SAML return on the app's origin (the server has already set the client cookie):
 * completes the pending sign-in/up, follows transferable OAuth attempts into sign-up, and routes
 * `needs_second_factor` / `needs_new_password` attempts back into the sign-in UI.
 */
export async function handleRedirectCallback(
  ctx: RedirectCallbackContext,
  params: HandleRedirectCallbackParams = {},
): Promise<HandleRedirectCallbackResult> {
  await ctx.refreshClient();
  const signIn = ctx.client()?.signIn ?? null;
  const signUp = ctx.client()?.signUp ?? null;
  const signInRedirect = params.signInForceRedirectUrl ?? ctx.options.afterSignInUrl ?? params.signInFallbackRedirectUrl ?? "/";
  const signUpRedirect = params.signUpForceRedirectUrl ?? ctx.options.afterSignUpUrl ?? params.signUpFallbackRedirectUrl ?? signInRedirect;

  if (signUp?.status === "complete" && signUp.createdSessionId) {
    await ctx.setActive({ session: signUp.createdSessionId });
    ctx.navigate(signUpRedirect, { replace: true });
    return { signIn, signUp };
  }
  if (signIn?.status === "complete" && signIn.createdSessionId) {
    await ctx.setActive({ session: signIn.createdSessionId });
    ctx.navigate(signInRedirect, { replace: true });
    return { signIn, signUp };
  }
  if (signIn?.firstFactorVerification?.status === "transferable") {
    const transferred = await ctx.signUp().create({ transfer: true });
    ctx.navigate(params.signUpForceRedirectUrl ?? ctx.options.signUpUrl ?? "/sign-up", { replace: true });
    return { signIn, signUp: transferred };
  }
  if (signIn?.status === "needs_second_factor") {
    ctx.navigate(appendQuery(params.secondFactorUrl ?? params.continueSignInUrl ?? ctx.options.signInUrl ?? "/sign-in", { redirect_url: signInRedirect }), {
      replace: true,
    });
    return { signIn, signUp };
  }
  if (signIn?.status === "needs_new_password") {
    ctx.navigate(appendQuery(params.resetPasswordUrl ?? ctx.options.signInUrl ?? "/sign-in", { redirect_url: signInRedirect }), { replace: true });
    return { signIn, signUp };
  }
  if (signIn) {
    ctx.navigate(appendQuery(params.firstFactorUrl ?? params.continueSignInUrl ?? ctx.options.signInUrl ?? "/sign-in", { redirect_url: signInRedirect }), {
      replace: true,
    });
    return { signIn, signUp };
  }
  if (signUp) {
    ctx.navigate(appendQuery(params.continueSignUpUrl ?? ctx.options.signUpUrl ?? "/sign-up", { redirect_url: signUpRedirect }), { replace: true });
    return { signIn, signUp };
  }
  ctx.navigate(params.signInFallbackRedirectUrl ?? ctx.options.afterSignInUrl ?? "/", { replace: true });
  return { signIn, signUp };
}
