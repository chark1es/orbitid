import type { OrbitInstance } from "../w6";
import type { SignUpResource } from "../types";
import { invokeMethod } from "./errors";
import { pickSignUp, signUpTarget } from "./client";

// ---------- sign up ----------

export async function signUpCreate(orbit: OrbitInstance, params: Record<string, unknown>): Promise<SignUpResource | null> {
  const raw = await invokeMethod(signUpTarget(orbit), ["create"], params);
  return pickSignUp(orbit, raw);
}

export async function signUpUpdate(orbit: OrbitInstance, params: Record<string, unknown>): Promise<SignUpResource | null> {
  const raw = await invokeMethod(signUpTarget(orbit), ["update"], params);
  return pickSignUp(orbit, raw);
}

export async function signUpPrepareVerification(
  orbit: OrbitInstance,
  strategy: string,
): Promise<SignUpResource | null> {
  const target = signUpTarget(orbit);
  const methods = strategy === "phone_code"
    ? ["preparePhoneNumberVerification", "prepare_phone_number_verification"]
    : ["prepareEmailAddressVerification", "prepare_email_address_verification"];
  const raw = await invokeMethod(target, methods, { strategy });
  return pickSignUp(orbit, raw);
}

export async function signUpAttemptVerification(
  orbit: OrbitInstance,
  strategy: string,
  code: string,
): Promise<SignUpResource | null> {
  const target = signUpTarget(orbit);
  const methods = strategy === "phone_code"
    ? ["attemptPhoneNumberVerification", "attempt_phone_number_verification"]
    : ["attemptEmailAddressVerification", "attempt_email_address_verification"];
  const raw = await invokeMethod(target, [...methods, "attemptVerification", "attempt_verification"], { strategy, code });
  return pickSignUp(orbit, raw);
}

export async function signUpAuthenticateWithRedirect(
  orbit: OrbitInstance,
  params: Record<string, unknown>,
): Promise<SignUpResource | null> {
  const raw = await invokeMethod(signUpTarget(orbit), ["authenticateWithRedirect", "authenticate_with_redirect"], params);
  return pickSignUp(orbit, raw);
}
