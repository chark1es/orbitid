import { isRecord } from "../guards";
import {
  type NormalizedEmailAddress,
  type NormalizedPhoneNumber,
  type NormalizedExternalAccount,
  type NormalizedPasskey,
  type NormalizedUser,
} from "./types";
import { type Cached, cached, read, str, bool, list, view, define, bindMethods } from "./utils";
import {
  normalizeEmail,
  normalizePhone,
  normalizeExternalAccount,
  normalizePasskey,
} from "./identifiers";

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
  "getTrustedDevices",
  "revokeTrustedDevice",
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

    define(target, {
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
      is_anonymous: bool(raw, "is_anonymous", "isAnonymous"),
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
