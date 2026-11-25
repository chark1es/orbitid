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
  UserOAuthApplicationJSON,
} from "@orbitid/shared";
import { startRegistration, type PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/browser";
import type { FapiClient } from "../fapi";
import { fetchData, fetchPaginated, fetchList, unwrap } from "./base";
import { paginationQuery, toList, type PaginatedResponse, type PaginationParams } from "../util/pagination";
import type { EmailAddress, PhoneNumber } from "./contact";
import { EmailAddress as EmailAddressClass, PhoneNumber as PhoneNumberClass } from "./contact";
import {
  BackupCodeResource,
  ExternalAccount,
  Passkey,
  TOTP,
  TrustedDevice,
  parseCredentialOptions,
  type PasskeyBeginJSON,
  type TOTPJSON,
  type TrustedDeviceJSON,
} from "./identity";
import type { OrganizationMembership } from "./organization";
import { OrganizationMembership as OrganizationMembershipClass } from "./organization";
import { OrganizationSuggestion as OrganizationSuggestionClass } from "./organization-suggestion";
import type { OrganizationSuggestion } from "./organization-suggestion";
import { UserOrganizationInvitation as UserOrganizationInvitationClass } from "./organization-user-invitation";
import type { UserOrganizationInvitation, UserOrganizationInvitationWireJSON } from "./organization-user-invitation";
import { Session } from "./session";
import type { TokenCache } from "../token-cache";

/** An OAuth application the signed-in user may use, from {@link User.getOAuthApplications}. */
export interface UserOAuthApplication {
  id: string;
  name: string;
  clientId: string;
  /** `null` for an instance-wide application. */
  organizationId: string | null;
  organization: { id: string; name: string; slug: string | null } | null;
  /** Why the user may use it: instance-wide, organization membership, or an operator access grant. */
  access: "instance" | "membership" | "grant";
  /** The operator-configured external billing portal, or `null`. */
  billingPortalUrl: string | null;
  createdAt: number;
}

function toUserOAuthApplication(json: UserOAuthApplicationJSON): UserOAuthApplication {
  return {
    id: json.id,
    name: json.name,
    clientId: json.client_id,
    organizationId: json.organization_id ?? null,
    organization: json.organization ?? null,
    access: json.access,
    billingPortalUrl: json.billing_portal_url ?? null,
    createdAt: json.created_at,
  };
}

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
    this.emailAddresses = (json.email_addresses ?? []).map((email) => EmailAddressClass.fromJSON(fapi, email, (updated) => this.applyJSON(updated)));
    this.phoneNumbers = (json.phone_numbers ?? []).map((phone) => PhoneNumberClass.fromJSON(fapi, phone, (updated) => this.applyJSON(updated)));
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
    this.emailAddresses = (json.email_addresses ?? []).map((email) => EmailAddressClass.fromJSON(this.fapi, email, (updated) => this.applyJSON(updated)));
    this.phoneNumbers = (json.phone_numbers ?? []).map((phone) => PhoneNumberClass.fromJSON(this.fapi, phone, (updated) => this.applyJSON(updated)));
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
    const email = EmailAddressClass.fromJSON(this.fapi, json, (updated) => this.applyJSON(updated));
    this.emailAddresses = [...this.emailAddresses.filter((item) => item.id !== email.id), email];
    return email;
  }

  async createPhoneNumber(params: { phoneNumber: string }): Promise<PhoneNumber> {
    const json = await fetchData<PhoneNumberJSON>(this.fapi, "POST", "/v1/client/me/phone_numbers", {
      body: { phone_number: params.phoneNumber },
    });
    const phone = PhoneNumberClass.fromJSON(this.fapi, json, (updated) => this.applyJSON(updated));
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

  /**
   * The OAuth applications this user may use (instance-wide, owned by an organization they belong to, or granted
   * to them by an operator), sorted by name.
   */
  async getOAuthApplications(): Promise<UserOAuthApplication[]> {
    const data = await fetchData<unknown>(this.fapi, "GET", "/v1/client/me/oauth_applications");
    return toList(data, (item) => toUserOAuthApplication(item as UserOAuthApplicationJSON));
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
