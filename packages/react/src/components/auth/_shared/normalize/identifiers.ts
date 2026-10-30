import { isRecord } from "../guards";
import type { VerificationLike } from "../types";
import {
  type NormalizedEmailAddress,
  type NormalizedPhoneNumber,
  type NormalizedExternalAccount,
  type NormalizedPasskey,
} from "./types";
import { type Cached, cached, read, str, bool, num, view, define, bindMethods } from "./utils";

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
    define(target, {
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
    define(target, {
      id: str(raw, "id") ?? "",
      phone_number: str(raw, "phone_number", "phoneNumber") ?? "",
      reserved_for_second_factor: bool(raw, "reserved_for_second_factor", "reservedForSecondFactor"),
      default_second_factor: bool(raw, "default_second_factor", "defaultSecondFactor"),
      verification: normalizeVerification(raw.verification),
    });
    bindMethods(target, raw, ["prepareVerification", "attemptVerification", "destroy", "setAsPrimary"]);
    const setReserved = raw.setReservedForSecondFactor;
    const setDefault = raw.makeDefaultSecondFactor;
    define(target, {
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
    define(target, {
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
    define(target, {
      id: str(raw, "id") ?? "",
      name: str(raw, "name") ?? "",
      created_at: num(raw, "created_at", "createdAt") ?? 0,
      last_used_at: num(raw, "last_used_at", "lastUsedAt"),
    });
    bindMethods(target, raw, ["delete"]);
    const rename = raw.rename;
    define(target, {
      update: async (params: Record<string, unknown>) => {
        if (typeof rename === "function") {
          await (rename as (params: { name: string }) => Promise<unknown>).call(raw, { name: String(params.name ?? "") });
        }
      },
    });
    return target;
  });
}
