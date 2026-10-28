import { decodePublishableKey } from "@orbitid/shared";
import type { SessionJSON, UserJSON } from "@orbitid/shared";
import type {
  AuthRuntime,
  EmailAddressResource,
  ExternalAccountResource,
  OrbitInstance,
  OrbitUser,
  PhoneNumberResource,
  SignInApi,
  SignUpApi,
  SignInFactorView,
} from "./w6";
import { normalizeClient, normalizeSession, normalizeSignIn, normalizeSignUp, normalizeUser, type NormalizedClient, type NormalizedSession } from "./normalize";
import type { SignInResource, SignUpResource, VerificationLike } from "./types";
import { isRecord } from "./guards";
import { isTranslationKey, type TranslateParams, type TranslationKey } from "../../../localization";

export class AuthUIError extends Error {
  code: string;
  longMessage?: string;
  meta?: Record<string, unknown>;

  constructor(code: string, message?: string, longMessage?: string, meta?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "AuthUIError";
    this.code = code;
    this.longMessage = longMessage;
    this.meta = meta;
  }
}

function firstErrorItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const list = value.errors;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first: unknown = list[0];
  return isRecord(first) ? first : null;
}

export function toAuthError(error: unknown): AuthUIError {
  if (error instanceof AuthUIError) return error;
  const item = firstErrorItem(error);
  if (item) {
    const code = typeof item.code === "string" ? item.code : "unexpected";
    const message = typeof item.message === "string" ? item.message : undefined;
    const longMessage = typeof item.long_message === "string" ? item.long_message : undefined;
    const meta = isRecord(item.meta) ? item.meta : undefined;
    return new AuthUIError(code, message, longMessage, meta);
  }
  if (isRecord(error)) {
    const nested = error.error;
    if (isRecord(nested) && typeof nested.code === "string") {
      return new AuthUIError(
        nested.code,
        typeof nested.message === "string" ? nested.message : undefined,
        typeof error.longMessage === "string" ? error.longMessage : undefined,
      );
    }
    if (typeof error.code === "string") {
      return new AuthUIError(
        error.code,
        typeof error.message === "string" ? error.message : undefined,
        typeof error.long_message === "string" ? error.long_message : undefined,
        isRecord(error.meta) ? error.meta : undefined,
      );
    }
  }
  if (error instanceof Error) {
    const network = error.name === "TypeError" && /fetch|network/i.test(error.message);
    return new AuthUIError(network ? "network" : "unexpected", error.message);
  }
  return new AuthUIError("unexpected");
}

/** Localized message for an API/UI error, falling back to the server's long message. */
export function errorMessage(t: (key: TranslationKey, params?: TranslateParams) => string, error: unknown): string {
  const authError = toAuthError(error);
  const meta = authError.meta;
  const params: TranslateParams | undefined = meta
    ? { min: String(meta.min_length ?? ""), max: String(meta.max_length ?? "") }
    : undefined;
  const unstableKey = `unstable__errors.${authError.code}` as TranslationKey;
  const unstable = t(unstableKey, params);
  if (unstable !== unstableKey) return unstable;
  const key = `errors.${authError.code}`;
  if (isTranslationKey(key)) return t(key, params);
  if (authError.longMessage) return authError.longMessage;
  if (authError.message && authError.message !== authError.code) return authError.message;
  return t("errors.unexpected");
}

export function isReverificationError(error: unknown): boolean {
  return toAuthError(error).code === "session_reverification_required";
}

export async function invokeMethod<T = unknown>(
  targets: unknown | unknown[],
  methods: readonly string[],
  args?: Record<string, unknown>,
): Promise<T> {
  for (const target of Array.isArray(targets) ? targets : [targets]) {
    if (!isRecord(target)) continue;
    for (const method of methods) {
      const fn = target[method];
      if (typeof fn === "function") {
        return (await (fn as (params?: unknown) => unknown).call(target, args)) as T;
      }
    }
  }
  throw new AuthUIError("not_supported", `OrbitID resource does not implement ${methods.join(" / ")}`);
}

function unwrap(value: unknown): unknown {
  if (isRecord(value)) {
    if ("response" in value && value.response !== undefined) return unwrap(value.response);
    if ("sign_in" in value && value.sign_in !== undefined) return unwrap(value.sign_in);
    if ("signIn" in value && value.signIn !== undefined) return unwrap(value.signIn);
    if ("sign_up" in value && value.sign_up !== undefined) return unwrap(value.sign_up);
    if ("signUp" in value && value.signUp !== undefined) return unwrap(value.signUp);
  }
  return value;
}

function clientOf(orbit: OrbitInstance): NormalizedClient | null {
  return normalizeClient(orbit.client);
}

export function currentClient(orbit: OrbitInstance): NormalizedClient | null {
  return normalizeClient(orbit.client);
}

export function currentSession(orbit: OrbitInstance): NormalizedSession | null {
  return normalizeSession(orbit.session);
}

function clientSignIn(orbit: OrbitInstance): SignInResource | null {
  return clientOf(orbit)?.sign_in ?? null;
}

function clientSignUp(orbit: OrbitInstance): SignUpResource | null {
  return clientOf(orbit)?.sign_up ?? null;
}

export function pickSignIn(orbit: OrbitInstance, result: unknown): SignInResource | null {
  const unwrapped = unwrap(result);
  if (isRecord(unwrapped) && typeof unwrapped.status === "string" && "id" in unwrapped) {
    return normalizeSignIn(unwrapped);
  }
  return clientSignIn(orbit);
}

export function pickSignUp(orbit: OrbitInstance, result: unknown): SignUpResource | null {
  const unwrapped = unwrap(result);
  if (isRecord(unwrapped) && typeof unwrapped.status === "string" && "id" in unwrapped) {
    return normalizeSignUp(unwrapped);
  }
  return clientSignUp(orbit);
}

export function pickSessionId(orbit: OrbitInstance, result?: unknown): string | null {
  const unwrapped = unwrap(result);
  if (isRecord(unwrapped) && typeof unwrapped.created_session_id === "string") {
    return unwrapped.created_session_id;
  }
  const signIn = clientSignIn(orbit);
  if (signIn?.created_session_id) return signIn.created_session_id;
  const signUp = clientSignUp(orbit);
  return signUp?.created_session_id ?? null;
}

function signInTarget(orbit: OrbitInstance): SignInApi | unknown {
  if (isRecord(orbit.signIn)) return orbit.signIn;
  const client = clientOf(orbit);
  if (client) {
    const camel: unknown = Reflect.get(client, "signIn");
    if (isRecord(camel)) return camel;
    const snake: unknown = client.sign_in;
    if (isRecord(snake) && typeof snake.create === "function") return snake;
  }
  return orbit;
}

function signUpTarget(orbit: OrbitInstance): SignUpApi | unknown {
  if (isRecord(orbit.signUp)) return orbit.signUp;
  const client = clientOf(orbit);
  if (client) {
    const camel: unknown = Reflect.get(client, "signUp");
    if (isRecord(camel)) return camel;
    const snake: unknown = client.sign_up;
    if (isRecord(snake) && typeof snake.create === "function") return snake;
  }
  return orbit;
}

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

// ---------- identity helpers ----------

export function primaryIdentifier(user: OrbitUser | null): string {
  if (!user) return "";
  const emails = user.email_addresses ?? [];
  const primaryEmail = emails.find((email) => email.id === user.primary_email_address_id) ?? emails[0];
  if (primaryEmail) return primaryEmail.email_address;
  const phones = user.phone_numbers ?? [];
  const primaryPhone = phones.find((phone) => phone.id === user.primary_phone_number_id) ?? phones[0];
  if (primaryPhone) return primaryPhone.phone_number;
  return user.username ?? "";
}

export function displayName(user: UserJSON | OrbitUser | null): string {
  if (!user) return "";
  const name = [user.first_name, user.last_name].filter((part): part is string => Boolean(part)).join(" ");
  return name || user.username || primaryIdentifier(user as OrbitUser);
}

export function initials(user: UserJSON | OrbitUser | null): string {
  if (!user) return "?";
  const parts = [user.first_name, user.last_name].filter((part): part is string => Boolean(part));
  if (parts.length > 0) return parts.map((part) => part.charAt(0).toUpperCase()).join("");
  const identifier = primaryIdentifier(user as OrbitUser);
  return identifier.charAt(0).toUpperCase() || "?";
}

export function factorsOf(signIn: SignInResource | null, kind: "first" | "second"): SignInFactorView[] {
  const list = kind === "first" ? signIn?.supported_first_factors : signIn?.supported_second_factors;
  return Array.isArray(list) ? list : [];
}

export function verificationStatus(verification: unknown): VerificationLike["status"] | null {
  return isRecord(verification) && typeof verification.status === "string"
    ? (verification.status as VerificationLike["status"])
    : null;
}

export function isTransferable(signIn: SignInResource | null): boolean {
  return (
    verificationStatus(signIn?.first_factor_verification) === "transferable" ||
    verificationStatus(signIn?.second_factor_verification) === "transferable"
  );
}

export function apiOrigin(orbit: OrbitInstance): string {
  const candidates = [orbit.frontendApi, orbit.frontendApiUrl, orbit.apiUrl];
  if (typeof orbit.publishableKey === "string") {
    try {
      candidates.push(decodePublishableKey(orbit.publishableKey).frontendApi);
    } catch {
      // Not a publishable key (tests/custom instances): fall through.
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate.replace(/\/$/, "");
  }
  return "";
}

export async function apiRequest<T = unknown>(
  orbit: OrbitInstance,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const origin = apiOrigin(orbit);
  const url = origin ? `${origin}${path}` : path;
  const { json, ...requestInit } = init ?? {};
  const headers = new Headers(requestInit.headers);
  let body = requestInit.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const response = await fetch(url, { credentials: "include", ...requestInit, headers, body });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    if (isRecord(payload) && Array.isArray(payload.errors)) throw toAuthError(payload);
    throw new AuthUIError("unexpected", `Request failed with status ${response.status}`);
  }
  const unwrapped = unwrap(payload);
  return unwrapped as T;
}
