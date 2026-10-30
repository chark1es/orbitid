import type { OrbitInstance } from "../w6";
import type { SignInResource } from "../types";
import { invokeMethod } from "./errors";
import { pickSignIn, signInTarget } from "./client";

export interface SignInResult {
  signIn: SignInResource | null;
  redirectUrl: string | null;
}

function redirectFromSignIn(signIn: SignInResource | null): string | null {
  const verification = signIn?.first_factor_verification ?? signIn?.second_factor_verification;
  if (verification && typeof verification.external_verification_redirect_url === "string") {
    return verification.external_verification_redirect_url;
  }
  return null;
}

export async function signInCreate(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResult> {
  const raw = await invokeMethod(signInTarget(orbit), ["create"], params);
  const signIn = pickSignIn(orbit, raw);
  return { signIn, redirectUrl: redirectFromSignIn(signIn) };
}

export async function signInPrepareFirstFactor(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResult> {
  const raw = await invokeMethod(signInTarget(orbit), ["prepareFirstFactor", "prepare_first_factor"], params);
  const signIn = pickSignIn(orbit, raw);
  return { signIn, redirectUrl: redirectFromSignIn(signIn) };
}

export async function signInAttemptFirstFactor(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResult> {
  const raw = await invokeMethod(signInTarget(orbit), ["attemptFirstFactor", "attempt_first_factor"], params);
  const signIn = pickSignIn(orbit, raw);
  return { signIn, redirectUrl: redirectFromSignIn(signIn) };
}

export async function signInPrepareSecondFactor(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResource | null> {
  const raw = await invokeMethod(signInTarget(orbit), ["prepareSecondFactor", "prepare_second_factor"], params);
  return pickSignIn(orbit, raw);
}

export async function signInAttemptSecondFactor(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResource | null> {
  // `@orbitid/js` maps `trustDevice` to the `trust_device` wire field.
  const raw = await invokeMethod(signInTarget(orbit), ["attemptSecondFactor", "attempt_second_factor"], params);
  return pickSignIn(orbit, raw);
}

export async function signInResetPassword(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResource | null> {
  const raw = await invokeMethod(signInTarget(orbit), ["resetPassword", "reset_password"], params);
  return pickSignIn(orbit, raw);
}

export async function signInAuthenticateWithRedirect(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignInResource | null> {
  const raw = await invokeMethod(signInTarget(orbit), ["authenticateWithRedirect", "authenticate_with_redirect"], params);
  return pickSignIn(orbit, raw);
}

export async function signInAuthenticateWithPasskey(
  orbit: OrbitInstance,
  options: Record<string, unknown> = {},
): Promise<SignInResult> {
  const raw = await invokeMethod(signInTarget(orbit), ["authenticateWithPasskey", "authenticate_with_passkey"], options);
  const signIn = pickSignIn(orbit, raw);
  return { signIn, redirectUrl: redirectFromSignIn(signIn) };
}

export async function signInReload(orbit: OrbitInstance): Promise<SignInResource | null> {
  const target = signInTarget(orbit);
  try {
    const raw = await invokeMethod(target, ["reload", "get"]);
    if (raw !== undefined && raw !== null) return pickSignIn(orbit, raw);
  } catch {
    // Polling is best-effort: fall back to reloading the whole client.
  }
  return null;
}
