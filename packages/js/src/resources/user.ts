import type {
  EmailAddressJSON,
  ExternalAccountJSON,
  Metadata,
  OrganizationMembershipJSON,
  OrganizationSuggestionJSON,
  PasskeyJSON,
  PhoneNumberJSON,
  SessionJSON,
  UserJSON,
} from "@orbitid/shared";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { FapiClient } from "../fapi";
import { fetchData, fetchPaginated, fetchList, unwrap } from "./base";
import { isRecord } from "../util/object";
import { paginationQuery, toList, type PaginatedResponse, type PaginationParams } from "../util/pagination";
import type { OrganizationMembership, OrganizationSuggestion, UserOrganizationInvitation } from "./organization";
import {
  OrganizationMembership as OrganizationMembershipClass,
  OrganizationSuggestion as OrganizationSuggestionClass,
  UserOrganizationInvitation as UserOrganizationInvitationClass,
  type UserOrganizationInvitationWireJSON,
} from "./organization";
import { Session } from "./session";
import { Verification } from "./verification";
import type { TokenCache } from "../token-cache";

export interface UpdateUserParams {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  primaryPhoneNumberId?: string | null;
  publicMetadata?: Metadata;
  unsafeMetadata?: Metadata;
  externalId?: string | null;
}

export class EmailAddress {
  readonly object = "email_address" as const;
  id: string;
  emailAddress: string;
  verification: Verification | null;
  linkedTo: { type: string; id: string }[];
  reserved: boolean;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: EmailAddressJSON,
    private readonly onUserUpdated?: (json: UserJSON) => void,
  ) {
    this.id = json.id;
    this.emailAddress = json.email_address;
    this.verification = Verification.fromJSON(json.verification);
    this.linkedTo = json.linked_to ?? [];
    this.reserved = json.reserved ?? false;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: EmailAddressJSON, onUserUpdated?: (json: UserJSON) => void): EmailAddress {
    return new EmailAddress(fapi, json, onUserUpdated);
  }

  get isVerified(): boolean {
    return this.verification?.status === "verified";
  }

  private applyJSON(json: EmailAddressJSON): this {
    this.emailAddress = json.email_address;
    this.verification = Verification.fromJSON(json.verification) ?? this.verification;
    this.updatedAt = json.updated_at;
    return this;
  }

  async prepareVerification({ strategy = "email_code" }: { strategy?: string } = {}): Promise<this> {
    const json = await fetchData<EmailAddressJSON>(this.fapi, "POST", `/v1/client/me/email_addresses/${this.id}/prepare_verification`, {
      body: { strategy },
    });
    return this.applyJSON(json);
  }

  async attemptVerification({ code }: { code: string }): Promise<this> {
    const json = await fetchData<EmailAddressJSON>(this.fapi, "POST", `/v1/client/me/email_addresses/${this.id}/attempt_verification`, {
      body: { code },
    });
    return this.applyJSON(json);
  }

  /** Makes this address the user's primary one (`PATCH /me`). */
  async setAsPrimary(): Promise<this> {
    const json = await fetchData<UserJSON>(this.fapi, "PATCH", "/v1/client/me", { body: { primary_email_address_id: this.id } });
    this.onUserUpdated?.(json);
    const updated = (json.email_addresses ?? []).find((email) => email.id === this.id);
    return updated ? this.applyJSON(updated) : this;
  }

  async destroy(): Promise<void> {
    await this.fapi.del(`/v1/client/me/email_addresses/${this.id}`);
  }
}

export interface PhoneNumberParams {
  reservedForSecondFactor?: boolean;
  defaultSecondFactor?: boolean;
}

export class PhoneNumber {
  readonly object = "phone_number" as const;
  id: string;
  phoneNumber: string;
  reservedForSecondFactor: boolean;
  defaultSecondFactor: boolean;
  verification: Verification | null;
  linkedTo: { type: string; id: string }[];
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: PhoneNumberJSON,
    private readonly onUserUpdated?: (json: UserJSON) => void,
  ) {
    this.id = json.id;
    this.phoneNumber = json.phone_number;
    this.reservedForSecondFactor = json.reserved_for_second_factor ?? false;
    this.defaultSecondFactor = json.default_second_factor ?? false;
    this.verification = Verification.fromJSON(json.verification);
    this.linkedTo = json.linked_to ?? [];
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: PhoneNumberJSON, onUserUpdated?: (json: UserJSON) => void): PhoneNumber {
    return new PhoneNumber(fapi, json, onUserUpdated);
  }

  get isVerified(): boolean {
    return this.verification?.status === "verified";
  }

  private applyJSON(json: PhoneNumberJSON): this {
    this.phoneNumber = json.phone_number;
    this.reservedForSecondFactor = json.reserved_for_second_factor ?? this.reservedForSecondFactor;
    this.defaultSecondFactor = json.default_second_factor ?? this.defaultSecondFactor;
    this.verification = Verification.fromJSON(json.verification) ?? this.verification;
    this.updatedAt = json.updated_at;
    return this;
  }

  async prepareVerification({ strategy = "phone_code" }: { strategy?: string } = {}): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "POST", `/v1/client/me/phone_numbers/${this.id}/prepare_verification`, {
      body: { strategy },
    });
    return this.applyJSON(json);
  }

  async attemptVerification({ code }: { code: string }): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "POST", `/v1/client/me/phone_numbers/${this.id}/attempt_verification`, {
      body: { code },
    });
    return this.applyJSON(json);
  }

  async setReservedForSecondFactor({ reserved }: { reserved: boolean }): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "PATCH", `/v1/client/me/phone_numbers/${this.id}`, {
      body: { reserved_for_second_factor: reserved },
    });
    return this.applyJSON(json);
  }

  async makeDefaultSecondFactor(): Promise<this> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "PATCH", `/v1/client/me/phone_numbers/${this.id}`, {
      body: { default_second_factor: true },
    });
    return this.applyJSON(json);
  }

  async setAsPrimary(): Promise<this> {
    const json = await fetchData<UserJSON>(this.fapi, "PATCH", "/v1/client/me", { body: { primary_phone_number_id: this.id } });
    this.onUserUpdated?.(json);
    const updated = (json.phone_numbers ?? []).find((phone) => phone.id === this.id);
    return updated ? this.applyJSON(updated) : this;
  }

  async destroy(): Promise<void> {
    await this.fapi.del(`/v1/client/me/phone_numbers/${this.id}`);
  }
}

export interface ReauthorizeParams {
  redirectUrl?: string;
  additionalScopes?: string[];
}

export class ExternalAccount {
  readonly object = "external_account" as const;
  id: string;
  provider: string;
  providerUserId: string;
  identificationId: string;
  emailAddress: string;
  firstName: string;
  lastName: string;
  username: string | null;
  imageUrl: string | null;
  avatarUrl: string | null;
  approvedScopes: string;
  publicMetadata: Metadata;
  label: string | null;
  verification: Verification | null;
  createdAt: number;
  updatedAt: number;

  constructor(private readonly fapi: FapiClient, json: ExternalAccountJSON) {
    this.id = json.id;
    this.provider = json.provider;
    this.providerUserId = json.provider_user_id;
    this.identificationId = json.identification_id;
    this.emailAddress = json.email_address;
    this.firstName = json.first_name;
    this.lastName = json.last_name;
    this.username = json.username;
    this.imageUrl = json.image_url;
    this.avatarUrl = json.avatar_url;
    this.approvedScopes = json.approved_scopes;
    this.publicMetadata = json.public_metadata ?? {};
    this.label = json.label;
    this.verification = Verification.fromJSON(json.verification);
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: ExternalAccountJSON): ExternalAccount {
    return new ExternalAccount(fapi, json);
  }

  /** Re-runs the OAuth flow for this provider (e.g. to refresh scopes). */
  async reauthorize(params: ReauthorizeParams = {}): Promise<this> {
    const raw = await this.fapi.post<unknown>("/v1/client/me/external_accounts", {
      body: {
        strategy: this.provider.startsWith("oauth_") ? this.provider : `oauth_${this.provider}`,
        redirect_url: params.redirectUrl,
        additional_scopes: params.additionalScopes,
      },
    });
    const data = unwrap<{ external_verification_redirect_url?: string; external_account?: ExternalAccountJSON }>(raw).data;
    if (data?.external_verification_redirect_url) this.fapi.redirectTo(data.external_verification_redirect_url);
    return this;
  }

  async destroy(): Promise<void> {
    await this.fapi.del(`/v1/client/me/external_accounts/${this.id}`);
  }
}

export class Passkey {
  readonly object = "passkey" as const;
  id: string;
  name: string;
  verification: Verification | null;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;

  constructor(private readonly fapi: FapiClient, json: PasskeyJSON) {
    this.id = json.id;
    this.name = json.name;
    this.verification = Verification.fromJSON(json.verification);
    this.lastUsedAt = json.last_used_at ?? null;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: PasskeyJSON): Passkey {
    return new Passkey(fapi, json);
  }

  async rename({ name }: { name: string }): Promise<this> {
    const json = await fetchData<PasskeyJSON>(this.fapi, "PATCH", `/v1/client/me/passkeys/${this.id}`, { body: { name } });
    this.name = json.name;
    this.updatedAt = json.updated_at;
    return this;
  }

  async delete(): Promise<void> {
    await this.fapi.del(`/v1/client/me/passkeys/${this.id}`);
  }
}

export interface TOTPJSON {
  id?: string;
  secret?: string;
  uri?: string;
  qr_code?: string;
  verified?: boolean;
  /** Plaintext single-use codes returned once by `attempt_verification`. */
  backup_codes?: ({ code: string } | string)[];
}

export class TOTP {
  readonly object = "totp" as const;
  id?: string;
  secret?: string;
  uri?: string;
  qrCode?: string;
  verified: boolean;
  /** The ten backup codes the server issues when TOTP verification completes. */
  backupCodes?: string[];

  constructor(json: TOTPJSON) {
    this.id = json.id;
    this.secret = json.secret;
    this.uri = json.uri;
    this.qrCode = json.qr_code ?? (json as { qrCode?: string }).qrCode;
    this.verified = json.verified ?? false;
    this.backupCodes = parseBackupCodes(json.backup_codes);
  }

  static fromJSON(json: TOTPJSON): TOTP {
    return new TOTP(json);
  }
}

function parseBackupCodes(value: TOTPJSON["backup_codes"]): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    return item && typeof item.code === "string" ? [item.code] : [];
  });
}

export interface TrustedDeviceJSON {
  object: "trusted_device";
  id: string;
  user_id: string;
  label: string | null;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A browser remembered for skipping the second factor. The token itself is an HttpOnly cookie. */
export class TrustedDevice {
  readonly object = "trusted_device" as const;
  id: string;
  userId: string;
  label: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: number;
  lastUsedAt: number | null;
  createdAt: number;

  constructor(private readonly fapi: FapiClient, json: TrustedDeviceJSON) {
    this.id = json.id;
    this.userId = json.user_id;
    this.label = json.label;
    this.userAgent = json.user_agent;
    this.ipAddress = json.ip_address;
    this.expiresAt = json.expires_at;
    this.lastUsedAt = json.last_used_at;
    this.createdAt = json.created_at;
  }

  static fromJSON(fapi: FapiClient, json: TrustedDeviceJSON): TrustedDevice {
    return new TrustedDevice(fapi, json);
  }

  async revoke(): Promise<void> {
    await this.fapi.del(`/v1/client/me/trusted_devices/${this.id}`);
  }
}

export class BackupCodeResource {
  readonly object = "backup_code" as const;
  /** Plaintext codes — only returned once, on creation/regeneration. */
  codes: string[];

  constructor(codes: string[]) {
    this.codes = codes;
  }

  static fromJSON(json: unknown): BackupCodeResource {
    if (Array.isArray(json)) {
      return new BackupCodeResource(
        json.flatMap((item) => {
          if (typeof item === "string") return [item];
          if (isRecord(item) && typeof item.code === "string") return [item.code];
          return [];
        }),
      );
    }
    if (isRecord(json)) {
      const record = json;
      const codes = Array.isArray(record.codes) ? record.codes : Array.isArray(record.backup_codes) ? record.backup_codes : [];
      return BackupCodeResource.fromJSON(codes);
    }
    return new BackupCodeResource([]);
  }
}

interface PasskeyBeginJSON {
  id?: string;
  passkey_id?: string;
  nonce?: string | Record<string, unknown>;
  options?: unknown;
  public_key_credential_creation_options?: unknown;
  object?: string;
}

function parseJsonOptions(candidate: unknown): unknown {
  if (typeof candidate !== "string") return candidate ?? null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function parseCredentialOptions(data: PasskeyBeginJSON | undefined): unknown {
  const explicit = data?.public_key_credential_creation_options ?? data?.options;
  if (explicit) return parseJsonOptions(explicit);
  const fromNonce = parseJsonOptions(data?.nonce);
  return fromNonce && typeof fromNonce === "object" ? fromNonce : null;
}

export class User {
  readonly object = "user" as const;
  id: string;
  externalId: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  hasImage: boolean;
  primaryEmailAddressId: string | null;
  primaryPhoneNumberId: string | null;
  passwordEnabled: boolean;
  totpEnabled: boolean;
  backupCodeEnabled: boolean;
  twoFactorEnabled: boolean;
  passkeys: Passkey[];
  emailAddresses: EmailAddress[];
  phoneNumbers: PhoneNumber[];
  externalAccounts: ExternalAccount[];
  publicMetadata: Metadata;
  unsafeMetadata: Metadata;
  /** Guest account: no identifiers yet, upgrades in place once one is added. */
  isAnonymous: boolean;
  banned: boolean;
  locked: boolean;
  lastSignInAt: number | null;
  lastActiveAt: number | null;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: UserJSON,
    private readonly tokenCache?: TokenCache,
  ) {
    this.id = json.id;
    this.externalId = json.external_id;
    this.username = json.username;
    this.firstName = json.first_name;
    this.lastName = json.last_name;
    this.imageUrl = json.image_url;
    this.hasImage = json.has_image;
    this.primaryEmailAddressId = json.primary_email_address_id;
    this.primaryPhoneNumberId = json.primary_phone_number_id;
    this.passwordEnabled = json.password_enabled;
    this.totpEnabled = json.totp_enabled;
    this.backupCodeEnabled = json.backup_code_enabled;
    this.twoFactorEnabled = json.two_factor_enabled;
    this.passkeys = (json.passkeys ?? []).map((passkey) => Passkey.fromJSON(fapi, passkey));
    this.emailAddresses = (json.email_addresses ?? []).map((email) => EmailAddress.fromJSON(fapi, email, (updated) => this.applyJSON(updated)));
    this.phoneNumbers = (json.phone_numbers ?? []).map((phone) => PhoneNumber.fromJSON(fapi, phone, (updated) => this.applyJSON(updated)));
    this.externalAccounts = (json.external_accounts ?? []).map((account) => ExternalAccount.fromJSON(fapi, account));
    this.publicMetadata = json.public_metadata ?? {};
    this.unsafeMetadata = json.unsafe_metadata ?? {};
    this.isAnonymous = json.is_anonymous ?? false;
    this.banned = json.banned ?? false;
    this.locked = json.locked ?? false;
    this.lastSignInAt = json.last_sign_in_at ?? null;
    this.lastActiveAt = json.last_active_at ?? null;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: UserJSON, tokenCache?: TokenCache): User {
    return new User(fapi, json, tokenCache);
  }

  get fullName(): string | null {
    const name = [this.firstName, this.lastName].filter(Boolean).join(" ");
    return name || this.username || this.primaryEmailAddress?.emailAddress || null;
  }

  get primaryEmailAddress(): EmailAddress | null {
    return this.emailAddresses.find((email) => email.id === this.primaryEmailAddressId) ?? this.emailAddresses[0] ?? null;
  }

  get primaryPhoneNumber(): PhoneNumber | null {
    return this.phoneNumbers.find((phone) => phone.id === this.primaryPhoneNumberId) ?? this.phoneNumbers[0] ?? null;
  }

  get hasVerifiedEmailAddress(): boolean {
    return this.emailAddresses.some((email) => email.isVerified);
  }

  get hasVerifiedPhoneNumber(): boolean {
    return this.phoneNumbers.some((phone) => phone.isVerified);
  }

  private applyJSON(json: UserJSON): this {
    this.externalId = json.external_id;
    this.username = json.username;
    this.firstName = json.first_name;
    this.lastName = json.last_name;
    this.imageUrl = json.image_url;
    this.hasImage = json.has_image;
    this.primaryEmailAddressId = json.primary_email_address_id;
    this.primaryPhoneNumberId = json.primary_phone_number_id;
    this.passwordEnabled = json.password_enabled;
    this.totpEnabled = json.totp_enabled;
    this.backupCodeEnabled = json.backup_code_enabled;
    this.twoFactorEnabled = json.two_factor_enabled;
    this.passkeys = (json.passkeys ?? []).map((passkey) => Passkey.fromJSON(this.fapi, passkey));
    this.emailAddresses = (json.email_addresses ?? []).map((email) => EmailAddress.fromJSON(this.fapi, email, (updated) => this.applyJSON(updated)));
    this.phoneNumbers = (json.phone_numbers ?? []).map((phone) => PhoneNumber.fromJSON(this.fapi, phone, (updated) => this.applyJSON(updated)));
    this.externalAccounts = (json.external_accounts ?? []).map((account) => ExternalAccount.fromJSON(this.fapi, account));
    this.publicMetadata = json.public_metadata ?? {};
    this.unsafeMetadata = json.unsafe_metadata ?? {};
    this.isAnonymous = json.is_anonymous ?? this.isAnonymous;
    this.updatedAt = json.updated_at;
    return this;
  }

  async update(params: UpdateUserParams): Promise<this> {
    const body: Record<string, unknown> = {};
    if (params.firstName !== undefined) body.first_name = params.firstName;
    if (params.lastName !== undefined) body.last_name = params.lastName;
    if (params.username !== undefined) body.username = params.username;
    if (params.primaryEmailAddressId !== undefined) body.primary_email_address_id = params.primaryEmailAddressId;
    if (params.primaryPhoneNumberId !== undefined) body.primary_phone_number_id = params.primaryPhoneNumberId;
    if (params.publicMetadata !== undefined) body.public_metadata = params.publicMetadata;
    if (params.unsafeMetadata !== undefined) body.unsafe_metadata = params.unsafeMetadata;
    if (params.externalId !== undefined) body.external_id = params.externalId;
    const json = await fetchData<UserJSON>(this.fapi, "PATCH", "/v1/client/me", { body });
    return this.applyJSON(json);
  }

  async updatePassword(params: {
    currentPassword?: string;
    newPassword: string;
    signOutOfOtherSessions?: boolean;
  }): Promise<this> {
    await this.fapi.post("/v1/client/me/change_password", {
      body: {
        current_password: params.currentPassword,
        new_password: params.newPassword,
        sign_out_of_other_sessions: params.signOutOfOtherSessions,
      },
    });
    return this;
  }

  async removePassword(params: { currentPassword: string }): Promise<this> {
    const json = await fetchData<UserJSON>(this.fapi, "POST", "/v1/client/me/remove_password", {
      body: { current_password: params.currentPassword },
    });
    return this.applyJSON(json);
  }

  async createEmailAddress(params: { email: string }): Promise<EmailAddress> {
    const json = await fetchData<EmailAddressJSON>(this.fapi, "POST", "/v1/client/me/email_addresses", {
      body: { email_address: params.email },
    });
    const email = EmailAddress.fromJSON(this.fapi, json, (updated) => this.applyJSON(updated));
    this.emailAddresses = [...this.emailAddresses.filter((item) => item.id !== email.id), email];
    return email;
  }

  async createPhoneNumber(params: { phoneNumber: string }): Promise<PhoneNumber> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "POST", "/v1/client/me/phone_numbers", {
      body: { phone_number: params.phoneNumber },
    });
    const phone = PhoneNumber.fromJSON(this.fapi, json, (updated) => this.applyJSON(updated));
    this.phoneNumbers = [...this.phoneNumbers.filter((item) => item.id !== phone.id), phone];
    return phone;
  }

  async createExternalAccount(params: { strategy: string; redirectUrl?: string; additionalScopes?: string[] }): Promise<ExternalAccount> {
    const json = await fetchData<ExternalAccountJSON & { external_verification_redirect_url?: string }>(
      this.fapi,
      "POST",
      "/v1/client/me/external_accounts",
      {
        body: {
          strategy: params.strategy,
          redirect_url: params.redirectUrl,
          additional_scopes: params.additionalScopes,
        },
      },
    );
    if (json.external_verification_redirect_url) this.fapi.redirectTo(json.external_verification_redirect_url);
    const account = ExternalAccount.fromJSON(this.fapi, json);
    this.externalAccounts = [...this.externalAccounts.filter((item) => item.id !== account.id), account];
    return account;
  }

  async createTOTP(): Promise<TOTP> {
    const json = await fetchData<TOTPJSON>(this.fapi, "POST", "/v1/client/me/totp");
    return TOTP.fromJSON(json);
  }

  async verifyTOTP(params: { code: string }): Promise<TOTP> {
    const json = await fetchData<TOTPJSON>(this.fapi, "POST", "/v1/client/me/totp/attempt_verification", { body: { code: params.code } });
    this.totpEnabled = true;
    this.twoFactorEnabled = true;
    return TOTP.fromJSON(json);
  }

  async disableTOTP(): Promise<void> {
    await this.fapi.del("/v1/client/me/totp");
    this.totpEnabled = false;
  }

  async createBackupCode(): Promise<BackupCodeResource> {
    const raw = await this.fapi.post<unknown>("/v1/client/me/backup_codes");
    this.backupCodeEnabled = true;
    return BackupCodeResource.fromJSON(unwrap<unknown>(raw).data);
  }

  /** Registers a WebAuthn passkey: begin → `startRegistration` → attempt_verification. */
  async createPasskey(params: { name?: string } = {}): Promise<Passkey> {
    const begin = await fetchData<PasskeyBeginJSON>(this.fapi, "POST", "/v1/client/me/passkeys", {
      body: params.name ? { name: params.name } : {},
    });
    const options = parseCredentialOptions(begin);
    if (!options) {
      if (begin.object === "passkey" && begin.id) {
        const existing = Passkey.fromJSON(this.fapi, begin as unknown as PasskeyJSON);
        this.passkeys = [...this.passkeys.filter((item) => item.id !== existing.id), existing];
        return existing;
      }
      throw new Error("OrbitID did not return passkey registration options");
    }
    const passkeyId = begin.id ?? begin.passkey_id;
    if (!passkeyId) throw new Error("OrbitID did not return a passkey id");
    const credential = await startRegistration({ optionsJSON: options as PublicKeyCredentialCreationOptionsJSON });
    const raw = await this.fapi.post<unknown>(`/v1/client/me/passkeys/${passkeyId}/attempt_verification`, {
      body: { public_key_credential: credential },
    });
    const data = unwrap<PasskeyJSON & { passkey?: PasskeyJSON }>(raw).data;
    const passkey = Passkey.fromJSON(this.fapi, data.passkey ?? data);
    this.passkeys = [...this.passkeys.filter((item) => item.id !== passkey.id), passkey];
    return passkey;
  }

  async setProfileImage(params: { file: Blob; uploaderUserId?: string }): Promise<this> {
    const formData = new FormData();
    formData.append("file", params.file);
    if (params.uploaderUserId) formData.append("uploader_user_id", params.uploaderUserId);
    const json = await fetchData<UserJSON>(this.fapi, "POST", "/v1/client/me/profile_image", { formData });
    return this.applyJSON(json);
  }

  async deleteProfileImage(): Promise<this> {
    const json = await fetchData<UserJSON>(this.fapi, "DELETE", "/v1/client/me/profile_image");
    return this.applyJSON(json);
  }

  async delete(): Promise<void> {
    await this.fapi.del("/v1/client/me");
  }

  async getSessions(): Promise<Session[]> {
    const data = await fetchData<unknown>(this.fapi, "GET", "/v1/client/sessions");
    return toList(data, (item) => Session.fromJSON(this.fapi, item as SessionJSON, this.tokenCache));
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.fapi.post(`/v1/client/me/sessions/${sessionId}/revoke`);
  }

  /** Browsers remembered for skipping the second factor. */
  async getTrustedDevices(): Promise<TrustedDevice[]> {
    const data = await fetchData<unknown>(this.fapi, "GET", "/v1/client/me/trusted_devices");
    return toList(data, (item) => TrustedDevice.fromJSON(this.fapi, item as TrustedDeviceJSON));
  }

  /** Revokes one remembered browser; its cookie stops working for the second factor. */
  async revokeTrustedDevice(deviceId: string): Promise<void> {
    await this.fapi.del(`/v1/client/me/trusted_devices/${deviceId}`);
  }

  async leaveOrganization(organizationId: string): Promise<void> {
    await this.fapi.del(`/v1/client/me/organization_memberships/${organizationId}`);
  }

  async getOrganizationMemberships(params: PaginationParams = {}): Promise<PaginatedResponse<OrganizationMembership>> {
    return fetchPaginated(
      this.fapi,
      "/v1/client/me/organization_memberships",
      { query: { ...paginationQuery(params), paginated: true } },
      (item) => OrganizationMembershipClass.fromJSON(this.fapi, item as OrganizationMembershipJSON),
    );
  }

  async getOrganizationInvitations(): Promise<UserOrganizationInvitation[]> {
    return fetchList(this.fapi, "/v1/client/me/organization_invitations", {}, (item) =>
      UserOrganizationInvitationClass.fromJSON(this.fapi, item as UserOrganizationInvitationWireJSON),
    );
  }

  async getOrganizationSuggestions(): Promise<OrganizationSuggestion[]> {
    return fetchList(this.fapi, "/v1/client/me/organization_suggestions", {}, (item) =>
      OrganizationSuggestionClass.fromJSON(this.fapi, item as OrganizationSuggestionJSON),
    );
  }
}
