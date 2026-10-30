/**
 * Reusable schemas for the OpenAPI document, mirroring `packages/shared/src/resources.ts`.
 *
 * Every object keeps its `object` discriminator as a `const`, every timestamp is epoch **milliseconds**, and
 * Backend-API-only fields (`private_metadata`, one-time secrets) are marked optional because the Frontend API omits
 * them.
 *
 * Grouped by resource area; see `./components/*.ts`.
 */
import type { Schema } from "./schema";
import { backupCode, client, emailAddress, externalAccount, externalAccountAccessToken, operatorSession, passkey, phoneNumber, session, sessionToken, signIn, signInFactor, signInToken, signUp, totp, trustedDevice, user, userRoles, verification } from "./components/identity";
import { allowlistIdentifier, blocklistIdentifier, invitation, jwtTemplate, organization, organizationDomain, organizationInvitation, organizationMembership, organizationMembershipRequest, organizationSuggestion, permission, role, waitlistEntry } from "./components/organizations";
import { webhookDelivery, webhookEndpoint } from "./components/webhooks";
import { apiKey, machine, machineToken } from "./components/machines";
import { auditLog, enterpriseConnection, jwks, oauthApplication, oauthApplicationList, oauthError, oauthIntrospection, oauthTokenResponse, openIdConfiguration, userInfo } from "./components/oauth";
import { environment, health, instance, instanceStats, signingKey, testingToken, totalCount } from "./components/instance";

export const allSchemas: Record<string, Schema> = {
  Verification: verification,
  EmailAddress: emailAddress,
  PhoneNumber: phoneNumber,
  ExternalAccount: externalAccount,
  Passkey: passkey,
  TrustedDevice: trustedDevice,
  OperatorSession: operatorSession,
  User: user,
  Session: session,
  SignIn: signIn,
  SignInFactor: signInFactor,
  SignUp: signUp,
  Client: client,
  Organization: organization,
  OrganizationMembership: organizationMembership,
  OrganizationInvitation: organizationInvitation,
  OrganizationDomain: organizationDomain,
  OrganizationMembershipRequest: organizationMembershipRequest,
  OrganizationSuggestion: organizationSuggestion,
  Role: role,
  Permission: permission,
  Invitation: invitation,
  WaitlistEntry: waitlistEntry,
  AllowlistIdentifier: allowlistIdentifier,
  BlocklistIdentifier: blocklistIdentifier,
  JwtTemplate: jwtTemplate,
  SignInToken: signInToken,
  UserRoles: userRoles,
  WebhookEndpoint: webhookEndpoint,
  WebhookDelivery: webhookDelivery,
  ApiKey: apiKey,
  Machine: machine,
  MachineToken: machineToken,
  OAuthApplication: oauthApplication,
  EnterpriseConnection: enterpriseConnection,
  AuditLog: auditLog,
  Totp: totp,
  BackupCode: backupCode,
  ExternalAccountAccessToken: externalAccountAccessToken,
  Environment: environment,
  Instance: instance,
  InstanceStats: instanceStats,
  SigningKey: signingKey,
  TestingToken: testingToken,
  TotalCount: totalCount,
  SessionToken: sessionToken,
  Health: health,
  Jwks: jwks,
  OpenIdConfiguration: openIdConfiguration,
  OAuthError: oauthError,
  OAuthTokenResponse: oauthTokenResponse,
  OAuthIntrospection: oauthIntrospection,
  OAuthApplicationList: oauthApplicationList,
  UserInfo: userInfo,
};
