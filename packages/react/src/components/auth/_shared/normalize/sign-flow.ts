import type { SignInStatus, SignUpStatus } from "@orbitid/shared";
import { isRecord } from "../guards";
import type { SignInFactorView, SignInResource, SignUpResource } from "../types";
import { type Cached, cached, read, str, bool, list, view, define, bindMethods } from "./utils";
import { normalizeVerification } from "./identifiers";

// ---------- sign in / sign up ----------

const factorCache = new WeakMap<object, Cached<SignInFactorView>>();

export function normalizeFactor(raw: unknown): SignInFactorView | null {
  if (!isRecord(raw)) return null;
  return cached(factorCache, raw, () => ({
    strategy: str(raw, "strategy") ?? "",
    email_address_id: str(raw, "email_address_id", "emailAddressId") ?? undefined,
    phone_number_id: str(raw, "phone_number_id", "phoneNumberId") ?? undefined,
    safe_identifier: str(raw, "safe_identifier", "safeIdentifier") ?? undefined,
    primary: bool(raw, "primary"),
    default: bool(raw, "default"),
  }));
}

const signInCache = new WeakMap<object, Cached<SignInResource>>();

export function normalizeSignIn(raw: unknown): SignInResource | null {
  if (!isRecord(raw)) return null;
  return cached(signInCache, raw, () => {
    const target = view(raw) as unknown as SignInResource;
    define(target, {
      id: str(raw, "id") ?? "",
      status: (str(raw, "status") ?? "needs_identifier") as SignInStatus,
      identifier: str(raw, "identifier"),
      supported_first_factors: list<unknown>(read(raw, "supported_first_factors", "supportedFirstFactors"))
        .map(normalizeFactor)
        .filter((factor): factor is SignInFactorView => factor !== null),
      supported_second_factors: list<unknown>(read(raw, "supported_second_factors", "supportedSecondFactors"))
        .map(normalizeFactor)
        .filter((factor): factor is SignInFactorView => factor !== null),
      first_factor_verification: normalizeVerification(read(raw, "first_factor_verification", "firstFactorVerification")),
      second_factor_verification: normalizeVerification(read(raw, "second_factor_verification", "secondFactorVerification")),
      created_session_id: str(raw, "created_session_id", "createdSessionId"),
    });
    bindMethods(target, raw, [
      "create",
      "reload",
      "prepareFirstFactor",
      "attemptFirstFactor",
      "prepareSecondFactor",
      "attemptSecondFactor",
      "resetPassword",
      "authenticateWithRedirect",
      "authenticateWithPasskey",
    ]);
    return target;
  });
}

const signUpCache = new WeakMap<object, Cached<SignUpResource>>();

export function normalizeSignUp(raw: unknown): SignUpResource | null {
  if (!isRecord(raw)) return null;
  return cached(signUpCache, raw, () => {
    const target = view(raw) as unknown as SignUpResource;
    const verifications = isRecord(raw.verifications) ? raw.verifications : {};
    define(target, {
      id: str(raw, "id") ?? "",
      status: (str(raw, "status") ?? "missing_requirements") as SignUpStatus,
      required_fields: list<string>(read(raw, "required_fields", "requiredFields")),
      optional_fields: list<string>(read(raw, "optional_fields", "optionalFields")),
      missing_fields: list<string>(read(raw, "missing_fields", "missingFields")),
      unverified_fields: list<string>(read(raw, "unverified_fields", "unverifiedFields")),
      username: str(raw, "username"),
      email_address: str(raw, "email_address", "emailAddress"),
      phone_number: str(raw, "phone_number", "phoneNumber"),
      first_name: str(raw, "first_name", "firstName"),
      last_name: str(raw, "last_name", "lastName"),
      password_enabled: bool(raw, "password_enabled", "passwordEnabled"),
      verifications: {
        email_address: normalizeVerification(
          read(verifications, "email_address", "emailAddress") ??
            read(raw, "email_address_verification", "emailAddressVerification"),
        ),
        phone_number: normalizeVerification(
          read(verifications, "phone_number", "phoneNumber") ??
            read(raw, "phone_number_verification", "phoneNumberVerification"),
        ),
        external_account: normalizeVerification(
          read(verifications, "external_account", "externalAccount") ??
            read(raw, "external_account_verification", "externalAccountVerification"),
        ),
        web3_wallet: normalizeVerification(
          read(verifications, "web3_wallet", "web3Wallet") ?? read(raw, "web3_wallet_verification", "web3WalletVerification"),
        ),
      },
      created_session_id: str(raw, "created_session_id", "createdSessionId"),
      created_user_id: str(raw, "created_user_id", "createdUserId"),
    });
    bindMethods(target, raw, [
      "create",
      "update",
      "reload",
      "prepareVerification",
      "attemptVerification",
      "prepareEmailAddressVerification",
      "attemptEmailAddressVerification",
      "preparePhoneNumberVerification",
      "attemptPhoneNumberVerification",
      "authenticateWithRedirect",
    ]);
    return target;
  });
}
