import type { ExternalAccountJSON, Metadata, PasskeyJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData, unwrap } from "./base";
import { isRecord } from "../util/object";
import { Verification } from "./verification";

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

export interface PasskeyBeginJSON {
  id?: string;
  passkey_id?: string;
  nonce?: string | Record<string, unknown>;
  options?: unknown;
  public_key_credential_creation_options?: unknown;
  object?: string;
}

export function parseJsonOptions(candidate: unknown): unknown {
  if (typeof candidate !== "string") return candidate ?? null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function parseCredentialOptions(data: PasskeyBeginJSON | undefined): unknown {
  const explicit = data?.public_key_credential_creation_options ?? data?.options;
  if (explicit) return parseJsonOptions(explicit);
  const fromNonce = parseJsonOptions(data?.nonce);
  return fromNonce && typeof fromNonce === "object" ? fromNonce : null;
}
