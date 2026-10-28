import type { SignInStatus, SignUpStatus } from "@orbitid/shared";
import { isRecord } from "./guards";
import type { SignInFactorView, SignInResource, SignUpResource, VerificationLike } from "./types";

export interface NormalizedEmailAddress {
  id: string;
  email_address: string;
  verification: VerificationLike | null;
  reserved: boolean;
  prepareVerification?(params?: { strategy?: string }): Promise<unknown>;
  attemptVerification?(params: { code: string }): Promise<unknown>;
  destroy?(): Promise<unknown>;
  [key: string]: unknown;
}

export interface NormalizedPhoneNumber {
  id: string;
  phone_number: string;
  reserved_for_second_factor: boolean;
  default_second_factor: boolean;
  verification: VerificationLike | null;
  prepareVerification?(params?: { strategy?: string }): Promise<unknown>;
  attemptVerification?(params: { code: string }): Promise<unknown>;
  destroy?(): Promise<unknown>;
  update?(params: Record<string, unknown>): Promise<unknown>;
  [key: string]: unknown;
}

export interface NormalizedExternalAccount {
  id: string;
  provider: string;
  email_address: string;
  username: string | null;
  approved_scopes: string;
  verification: VerificationLike | null;
  destroy?(): Promise<unknown>;
  reauthorize?(params?: Record<string, unknown>): Promise<unknown>;
  [key: string]: unknown;
}

export interface NormalizedPasskey {
  id: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
  update?(params: Record<string, unknown>): Promise<unknown>;
  delete?(): Promise<unknown>;
  [key: string]: unknown;
}

export interface NormalizedTOTP {
  secret?: string;
  uri?: string;
  qr_code?: string;
  qrCode?: string;
  qrCodeUrl?: string;
  [key: string]: unknown;
}

export interface NormalizedUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  image_url: string;
  has_image: boolean;
  primary_email_address_id: string | null;
  primary_phone_number_id: string | null;
  password_enabled: boolean;
  totp_enabled: boolean;
  backup_code_enabled: boolean;
  two_factor_enabled: boolean;
  delete_self_enabled: boolean;
  email_addresses: NormalizedEmailAddress[];
  phone_numbers: NormalizedPhoneNumber[];
  external_accounts: NormalizedExternalAccount[];
  passkeys: NormalizedPasskey[];
  update?(params: Record<string, unknown>): Promise<unknown>;
  delete?(): Promise<unknown>;
  setProfileImage?(params: { file: File }): Promise<unknown>;
  deleteProfileImage?(): Promise<unknown>;
  removeProfileImage?(): Promise<unknown>;
  updatePassword?(params: { currentPassword?: string; newPassword: string; signOutOfOtherSessions?: boolean }): Promise<unknown>;
  removePassword?(params: { currentPassword: string }): Promise<unknown>;
  createEmailAddress?(params: { email: string }): Promise<NormalizedEmailAddress>;
  createPhoneNumber?(params: { phoneNumber: string }): Promise<NormalizedPhoneNumber>;
  createExternalAccount?(params: Record<string, unknown>): Promise<unknown>;
  createTOTP?(): Promise<NormalizedTOTP>;
  verifyTOTP?(params: { code: string }): Promise<unknown>;
  disableTOTP?(): Promise<unknown>;
  createBackupCode?(): Promise<{ codes?: string[] } | string[]>;
  createPasskey?(params?: { name?: string }): Promise<unknown>;
  getSessions?(): Promise<NormalizedSession[]>;
  revokeSession?(sessionId: string): Promise<unknown>;
  getEnterpriseAccounts?(): Promise<unknown[]>;
  [key: string]: unknown;
}

/**
 * `@orbitid/js` resources are camelCase classes; the UI records (and `@orbitid/shared` wire types)
 * are snake_case. These adapters expose the snake_case view *and* keep the live class prototype so
 * resource methods keep working. Cached per object and invalidated on every SDK state change.
 */

let epoch = 0;
export function invalidateNormalizedResources(): void {
  epoch += 1;
}

interface Cached<T> {
  epoch: number;
  value: T;
}

function cached<T extends object>(store: WeakMap<object, Cached<T>>, raw: object, build: () => T): T {
  const existing = store.get(raw);
  if (existing && existing.epoch === epoch) return existing.value;
  const value = build();
  store.set(raw, { epoch, value });
  return value;
}

function read(record: Record<string, unknown>, snake: string, camel?: string): unknown {
  const value = record[snake];
  if (value !== undefined) return value;
  return camel ? record[camel] : undefined;
}

function str(record: Record<string, unknown>, snake: string, camel?: string): string | null {
  const value = read(record, snake, camel);
  return typeof value === "string" ? value : null;
}

function bool(record: Record<string, unknown>, snake: string, camel?: string, fallback = false): boolean {
  const value = read(record, snake, camel);
  return typeof value === "boolean" ? value : fallback;
}

function num(record: Record<string, unknown>, snake: string, camel?: string): number | null {
  const value = read(record, snake, camel);
  return typeof value === "number" ? value : null;
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((entry) => entry !== null && entry !== undefined) as T[]) : [];
}

function view<T extends object>(raw: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(raw)) as T, raw);
}

function bindMethods(target: object, raw: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names) {
    const method = raw[name];
    if (typeof method === "function") {
      Object.assign(target, { [name]: (...args: unknown[]) => (method as (...a: unknown[]) => unknown).apply(raw, args) });
    }
  }
}

// ---------- verification ----------

const verificationCache = new WeakMap<object, Cached<VerificationLike>>();

export function normalizeVerification(raw: unknown): VerificationLike | null {
  if (!isRecord(raw)) return null;
  return cached(verificationCache, raw, () => ({
    status: (str(raw, "status") ?? "unverified") as VerificationLike["status"],
    strategy: str(raw, "strategy") ?? "",
    attempts: typeof read(raw, "attempts") === "number" ? (read(raw, "attempts") as number) : null,
    expire_at: num(raw, "expire_at", "expireAt"),
    external_verification_redirect_url: str(raw, "external_verification_redirect_url", "externalVerificationRedirectUrl"),
    error: isRecord(raw.error) ? { code: str(raw.error, "code") ?? "", message: str(raw.error, "message") ?? "" } : null,
    nonce: str(raw, "nonce"),
  }));
}

// ---------- identifiers ----------

const emailCache = new WeakMap<object, Cached<NormalizedEmailAddress>>();

export function normalizeEmail(raw: unknown): NormalizedEmailAddress | null {
  if (!isRecord(raw)) return null;
  return cached(emailCache, raw, () => {
    const target = view(raw) as NormalizedEmailAddress;
    Object.assign(target, {
      id: str(raw, "id") ?? "",
      email_address: str(raw, "email_address", "emailAddress") ?? "",
      verification: normalizeVerification(raw.verification),
      reserved: bool(raw, "reserved"),
    });
    bindMethods(target, raw, ["prepareVerification", "attemptVerification", "destroy", "setAsPrimary", "update"]);
    return target;
  });
}

const phoneCache = new WeakMap<object, Cached<NormalizedPhoneNumber>>();

export function normalizePhone(raw: unknown): NormalizedPhoneNumber | null {
  if (!isRecord(raw)) return null;
  return cached(phoneCache, raw, () => {
    const target = view(raw) as NormalizedPhoneNumber;
    Object.assign(target, {
      id: str(raw, "id") ?? "",
      phone_number: str(raw, "phone_number", "phoneNumber") ?? "",
      reserved_for_second_factor: bool(raw, "reserved_for_second_factor", "reservedForSecondFactor"),
      default_second_factor: bool(raw, "default_second_factor", "defaultSecondFactor"),
      verification: normalizeVerification(raw.verification),
    });
    bindMethods(target, raw, ["prepareVerification", "attemptVerification", "destroy", "setAsPrimary"]);
    const setReserved = raw.setReservedForSecondFactor;
    const setDefault = raw.makeDefaultSecondFactor;
    Object.assign(target, {
      update: async (params: Record<string, unknown>) => {
        if (params.reservedForSecondFactor !== undefined && typeof setReserved === "function") {
          await (setReserved as (params: { reserved: boolean }) => Promise<unknown>).call(raw, {
            reserved: Boolean(params.reservedForSecondFactor),
          });
        }
        if (params.defaultSecondFactor && typeof setDefault === "function") {
          await (setDefault as () => Promise<unknown>).call(raw);
        }
      },
    });
    return target;
  });
}

const externalCache = new WeakMap<object, Cached<NormalizedExternalAccount>>();

export function normalizeExternalAccount(raw: unknown): NormalizedExternalAccount | null {
  if (!isRecord(raw)) return null;
  return cached(externalCache, raw, () => {
    const target = view(raw) as NormalizedExternalAccount;
    Object.assign(target, {
      id: str(raw, "id") ?? "",
      provider: str(raw, "provider") ?? "",
      email_address: str(raw, "email_address", "emailAddress") ?? "",
      username: str(raw, "username"),
      approved_scopes: str(raw, "approved_scopes", "approvedScopes") ?? "",
      verification: normalizeVerification(raw.verification),
    });
    bindMethods(target, raw, ["destroy", "reauthorize", "reconnect"]);
    return target;
  });
}

const passkeyCache = new WeakMap<object, Cached<NormalizedPasskey>>();

export function normalizePasskey(raw: unknown): NormalizedPasskey | null {
  if (!isRecord(raw)) return null;
  return cached(passkeyCache, raw, () => {
    const target = view(raw) as NormalizedPasskey;
    Object.assign(target, {
      id: str(raw, "id") ?? "",
      name: str(raw, "name") ?? "",
      created_at: num(raw, "created_at", "createdAt") ?? 0,
      last_used_at: num(raw, "last_used_at", "lastUsedAt"),
    });
    bindMethods(target, raw, ["delete"]);
    const rename = raw.rename;
    Object.assign(target, {
      update: async (params: Record<string, unknown>) => {
        if (typeof rename === "function") {
          await (rename as (params: { name: string }) => Promise<unknown>).call(raw, { name: String(params.name ?? "") });
        }
      },
    });
    return target;
  });
}

// ---------- user ----------

const userCache = new WeakMap<object, Cached<NormalizedUser>>();
const USER_METHODS = [
  "update",
  "delete",
  "setProfileImage",
  "deleteProfileImage",
  "removeProfileImage",
  "updatePassword",
  "removePassword",
  "createEmailAddress",
  "createPhoneNumber",
  "createExternalAccount",
  "createTOTP",
  "verifyTOTP",
  "disableTOTP",
  "createBackupCode",
  "createPasskey",
  "getSessions",
  "revokeSession",
  "getEnterpriseAccounts",
] as const;

export function normalizeUser(raw: unknown): NormalizedUser | null {
  if (!isRecord(raw)) return null;
  return cached(userCache, raw, () => {
    const target = view(raw) as NormalizedUser;
    const emails = list<unknown>(read(raw, "email_addresses", "emailAddresses"))
      .map(normalizeEmail)
      .filter((email): email is NormalizedEmailAddress => email !== null);
    const phones = list<unknown>(read(raw, "phone_numbers", "phoneNumbers"))
      .map(normalizePhone)
      .filter((phone): phone is NormalizedPhoneNumber => phone !== null);
    const external = list<unknown>(read(raw, "external_accounts", "externalAccounts"))
      .map(normalizeExternalAccount)
      .filter((account): account is NormalizedExternalAccount => account !== null);
    const passkeys = list<unknown>(read(raw, "passkeys"))
      .map(normalizePasskey)
      .filter((passkey): passkey is NormalizedPasskey => passkey !== null);

    Object.assign(target, {
      id: str(raw, "id") ?? "",
      first_name: str(raw, "first_name", "firstName"),
      last_name: str(raw, "last_name", "lastName"),
      username: str(raw, "username"),
      image_url: str(raw, "image_url", "imageUrl") ?? "",
      has_image: bool(raw, "has_image", "hasImage"),
      primary_email_address_id: str(raw, "primary_email_address_id", "primaryEmailAddressId"),
      primary_phone_number_id: str(raw, "primary_phone_number_id", "primaryPhoneNumberId"),
      password_enabled: bool(raw, "password_enabled", "passwordEnabled"),
      totp_enabled: bool(raw, "totp_enabled", "totpEnabled"),
      backup_code_enabled: bool(raw, "backup_code_enabled", "backupCodeEnabled"),
      two_factor_enabled: bool(raw, "two_factor_enabled", "twoFactorEnabled"),
      delete_self_enabled: bool(raw, "delete_self_enabled", "deleteSelfEnabled", true),
      email_addresses: emails,
      phone_numbers: phones,
      external_accounts: external,
      passkeys,
    });
    bindMethods(target, raw, USER_METHODS);
    return target;
  });
}

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
    Object.assign(target, {
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
    Object.assign(target, {
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

// ---------- client / sessions ----------

export interface NormalizedSession {
  id: string;
  status: string;
  public_user_data: {
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string;
    has_image?: boolean;
    identifier?: string;
    user_id?: string;
  } | null;
  latest_activity: {
    browser_name?: string;
    device_type?: string;
    city?: string | null;
    country?: string | null;
    ip_address?: string;
  } | null;
  last_active_at: number | null;
  expire_at?: number;
  [key: string]: unknown;
}

const sessionCache = new WeakMap<object, Cached<NormalizedSession>>();

export function normalizeSession(raw: unknown): NormalizedSession | null {
  if (!isRecord(raw)) return null;
  return cached(sessionCache, raw, () => {
    const target = view(raw) as NormalizedSession;
    const publicUser = read(raw, "public_user_data", "publicUserData");
    const activity = read(raw, "latest_activity", "latestActivity");
    Object.assign(target, {
      id: str(raw, "id") ?? "",
      status: str(raw, "status") ?? "active",
      public_user_data: isRecord(publicUser)
        ? {
            user_id: str(publicUser, "user_id", "userId") ?? undefined,
            first_name: str(publicUser, "first_name", "firstName"),
            last_name: str(publicUser, "last_name", "lastName"),
            image_url: str(publicUser, "image_url", "imageUrl") ?? undefined,
            has_image: bool(publicUser, "has_image", "hasImage"),
            identifier: str(publicUser, "identifier") ?? undefined,
          }
        : null,
      latest_activity: isRecord(activity)
        ? {
            browser_name: str(activity, "browser_name", "browserName") ?? undefined,
            device_type: str(activity, "device_type", "deviceType") ?? undefined,
            city: str(activity, "city"),
            country: str(activity, "country"),
            ip_address: str(activity, "ip_address", "ipAddress") ?? undefined,
          }
        : null,
      last_active_at: num(raw, "last_active_at", "lastActiveAt"),
      expire_at: num(raw, "expire_at", "expireAt") ?? undefined,
    });
    bindMethods(target, raw, ["revoke", "end", "remove", "touch", "getToken"]);
    return target;
  });
}

export interface NormalizedClient {
  id: string;
  sessions: NormalizedSession[];
  sign_in: SignInResource | null;
  sign_up: SignUpResource | null;
  last_active_session_id: string | null;
}

const clientCache = new WeakMap<object, Cached<NormalizedClient>>();

export function normalizeClient(raw: unknown): NormalizedClient | null {
  if (!isRecord(raw)) return null;
  return cached(clientCache, raw, () => ({
    id: str(raw, "id") ?? "",
    sessions: list<unknown>(raw.sessions)
      .map(normalizeSession)
      .filter((session): session is NormalizedSession => session !== null),
    sign_in: normalizeSignIn(read(raw, "sign_in", "signIn")),
    sign_up: normalizeSignUp(read(raw, "sign_up", "signUp")),
    last_active_session_id: str(raw, "last_active_session_id", "lastActiveSessionId"),
  }));
}
