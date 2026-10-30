import type { VerificationLike } from "../types";
import type { NormalizedSession } from "./session-client";

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
  /** Guest account with no identifier yet. */
  is_anonymous: boolean;
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
