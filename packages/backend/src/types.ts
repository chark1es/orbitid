import type {
  AllowlistIdentifierJSON,
  ApiKeyJSON,
  AuditLogJSON,
  BlocklistIdentifierJSON,
  ClientJSON,
  DeletedObjectJSON,
  EmailAddressJSON,
  EnterpriseConnectionJSON,
  ExternalAccountJSON,
  InvitationJSON,
  JwtTemplateJSON,
  M2MMachineJSON,
  M2MTokenJSON,
  OAuthApplicationJSON,
  OrganizationDomainJSON,
  OrganizationInvitationJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  OrganizationMembershipRequestJSON,
  PasskeyJSON,
  PermissionJSON,
  PhoneNumberJSON,
  RoleJSON,
  SessionJSON,
  SignInTokenJSON,
  UserJSON,
  UserRolesJSON,
  WaitlistEntryJSON,
  WebhookDeliveryJSON,
  WebhookEndpointJSON,
} from "@orbitid/shared";
import type { Camelize } from "./case";

export type User = Camelize<UserJSON>;
export type EmailAddress = Camelize<EmailAddressJSON>;
export type PhoneNumber = Camelize<PhoneNumberJSON>;
export type ExternalAccount = Camelize<ExternalAccountJSON>;
export type Passkey = Camelize<PasskeyJSON>;
export type Session = Camelize<SessionJSON>;
export type Client = Camelize<ClientJSON>;
export type Organization = Camelize<OrganizationJSON>;
export type OrganizationMembership = Camelize<OrganizationMembershipJSON>;
export type OrganizationInvitation = Camelize<OrganizationInvitationJSON>;
export type OrganizationDomain = Camelize<OrganizationDomainJSON>;
export type OrganizationMembershipRequest = Camelize<OrganizationMembershipRequestJSON>;
export type Role = Camelize<RoleJSON>;
export type Permission = Camelize<PermissionJSON>;
export type Invitation = Camelize<InvitationJSON>;
export type WaitlistEntry = Camelize<WaitlistEntryJSON>;
export type AllowlistIdentifier = Camelize<AllowlistIdentifierJSON>;
export type BlocklistIdentifier = Camelize<BlocklistIdentifierJSON>;
export type JwtTemplate = Camelize<JwtTemplateJSON>;
export type SignInToken = Camelize<SignInTokenJSON>;
export type UserRoles = Camelize<UserRolesJSON>;
export type WebhookEndpoint = Camelize<WebhookEndpointJSON>;
export type WebhookDelivery = Camelize<WebhookDeliveryJSON>;
export type ApiKey = Camelize<ApiKeyJSON>;
export type M2MMachine = Camelize<M2MMachineJSON>;
export type M2MToken = Camelize<M2MTokenJSON>;
export type M2MTokenVerification = M2MToken & { valid: boolean; machine: M2MMachine };
export type OAuthApplication = Camelize<OAuthApplicationJSON>;
export type EnterpriseConnection = Camelize<EnterpriseConnectionJSON>;
export type AuditLog = Camelize<AuditLogJSON>;
export type DeletedObject = Camelize<DeletedObjectJSON>;

export interface PaginatedResult<T> {
  data: T[];
  totalCount: number;
}

export interface ListParams {
  limit?: number;
  offset?: number;
  orderBy?: string;
  query?: string;
}

export interface SessionToken {
  jwt: string;
}

export interface VerifyPasswordResult {
  verified: boolean;
}

export interface VerifyTOTPResult {
  verified: boolean;
}

export interface InstanceSettingsResource {
  [key: string]: unknown;
}

export interface TestingToken {
  token: string;
  expiresAt: number | null;
}

export interface Stats {
  [key: string]: unknown;
}
