import type { SessionJSON } from "@orbitid/shared";
import type {
  AuthRuntime,
  EmailAddressResource,
  ExternalAccountResource,
  OrbitInstance,
  OrbitUser,
  PhoneNumberResource,
} from "../w6";
import { normalizeUser } from "../normalize";
import { isRecord } from "../guards";
import { AuthUIError, invokeMethod } from "./errors";
import { currentClient } from "./client";

// ---------- session activation ----------

export function findSession(orbit: OrbitInstance, sessionId: string): SessionJSON | string {
  const sessions = currentClient(orbit)?.sessions ?? [];
  const match = sessions.find((session) => session.id === sessionId);
  return (match as unknown as SessionJSON | undefined) ?? sessionId;
}

export async function activateSession(orbit: OrbitInstance, sessionId: string): Promise<void> {
  const session = findSession(orbit, sessionId);
  const targets: unknown[] = [orbit];
  if (isRecord(orbit.client)) targets.push(orbit.client);
  await invokeMethod(targets, ["setActive", "set_active"], { session });
}

export async function finishAuth(
  runtime: AuthRuntime,
  sessionId: string | null,
  redirectUrl?: string,
): Promise<void> {
  if (!sessionId) {
    throw new AuthUIError("session_missing", "The sign in did not create a session.");
  }
  await activateSession(runtime.orbit, sessionId);
  runtime.refresh();
  if (redirectUrl) runtime.navigate(redirectUrl, { replace: true });
}

export async function signOut(runtime: AuthRuntime, opts?: { sessionId?: string; redirectUrl?: string }): Promise<void> {
  const orbit = runtime.orbit;
  await invokeMethod(orbit, ["signOut", "sign_out"], opts?.sessionId ? { sessionId: opts.sessionId } : undefined);
  runtime.refresh();
  if (opts?.redirectUrl) runtime.navigate(opts.redirectUrl, { replace: true });
}

// ---------- user ----------

export function currentUser(orbit: OrbitInstance): OrbitUser | null {
  return normalizeUser(orbit.user);
}

export function findEmail(user: OrbitUser | null, id: string): EmailAddressResource | undefined {
  return user?.email_addresses?.find((email) => email.id === id);
}

export function findPhone(user: OrbitUser | null, id: string): PhoneNumberResource | undefined {
  return user?.phone_numbers?.find((phone) => phone.id === id);
}

export function findExternalAccount(user: OrbitUser | null, id: string): ExternalAccountResource | undefined {
  return user?.external_accounts?.find((account) => account.id === id);
}

export async function prepareEmailVerification(
  email: EmailAddressResource,
  strategy: "email_code" | "email_link" = "email_code",
): Promise<unknown> {
  return invokeMethod(email, ["prepareVerification", "prepare_verification"], { strategy });
}

export async function attemptEmailVerification(email: EmailAddressResource, code: string): Promise<unknown> {
  return invokeMethod(email, ["attemptVerification", "attempt_verification"], { code });
}

export async function preparePhoneVerification(
  phone: PhoneNumberResource,
  strategy: "phone_code" = "phone_code",
): Promise<unknown> {
  return invokeMethod(phone, ["prepareVerification", "prepare_verification"], { strategy });
}

export async function attemptPhoneVerification(phone: PhoneNumberResource, code: string): Promise<unknown> {
  return invokeMethod(phone, ["attemptVerification", "attempt_verification"], { code });
}

/** Re-fetch the client from the Frontend API (session status, user flags) when the SDK offers it. */
export async function refreshClient(orbit: OrbitInstance): Promise<void> {
  const method: unknown = Reflect.get(orbit, "refreshClient");
  if (typeof method === "function") await (method as () => Promise<unknown>).call(orbit);
}

export async function reloadOrbit(orbit: OrbitInstance): Promise<void> {
  if (typeof orbit.load === "function") {
    try {
      await orbit.load();
    } catch {
      // State may already be current; callers re-read from the instance.
    }
  }
}
