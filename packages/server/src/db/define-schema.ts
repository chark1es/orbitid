// Every table, defined once across cohesive groups. `kit` supplies the dialect's column builders,
// so the Postgres and SQLite schemas cannot drift.
import type { Kit } from "./kit";
import { identityTables } from "./schema-parts/identity";
import { sessionsTables } from "./schema-parts/sessions";
import { organizationsTables } from "./schema-parts/organizations";
import { tokensTables } from "./schema-parts/tokens";
import { devicesTables } from "./schema-parts/devices";
import { webhooksTables } from "./schema-parts/webhooks";
import { apiTables } from "./schema-parts/api";

type Meta = Record<string, unknown>;

export function defineSchema(kit: Kit) {
  const identity = identityTables(kit);
  const sessions = sessionsTables(kit, identity.users);
  const organizations = organizationsTables(kit, identity.users);
  const tokens = tokensTables(kit, identity.users);
  const webhooks = webhooksTables(kit);
  const api = apiTables(kit, identity.users);
  const devices = devicesTables(kit, identity.users, api.oauthApplications);

  return {
    instance: identity.instance,
    signingKeys: identity.signingKeys,
    users: identity.users,
    emailAddresses: identity.emailAddresses,
    phoneNumbers: identity.phoneNumbers,
    externalAccounts: identity.externalAccounts,
    passkeys: identity.passkeys,
    clients: sessions.clients,
    sessions: sessions.sessions,
    signIns: sessions.signIns,
    signUps: sessions.signUps,
    verifications: sessions.verifications,
    oauthStates: sessions.oauthStates,
    rateLimits: sessions.rateLimits,
    organizations: organizations.organizations,
    roles: organizations.roles,
    permissions: organizations.permissions,
    rolePermissions: organizations.rolePermissions,
    userRoles: organizations.userRoles,
    organizationMemberships: organizations.organizationMemberships,
    organizationInvitations: organizations.organizationInvitations,
    organizationDomains: organizations.organizationDomains,
    organizationMembershipRequests: organizations.organizationMembershipRequests,
    invitations: organizations.invitations,
    waitlistEntries: organizations.waitlistEntries,
    allowlistIdentifiers: organizations.allowlistIdentifiers,
    blocklistIdentifiers: organizations.blocklistIdentifiers,
    jwtTemplates: tokens.jwtTemplates,
    actorTokens: tokens.actorTokens,
    signInTokens: tokens.signInTokens,
    webhookEndpoints: webhooks.webhookEndpoints,
    webhookEvents: webhooks.webhookEvents,
    webhookDeliveries: webhooks.webhookDeliveries,
    apiKeys: api.apiKeys,
    machines: api.machines,
    m2mTokens: api.m2mTokens,
    oauthApplications: api.oauthApplications,
    oauthGrants: api.oauthGrants,
    oauthConsents: api.oauthConsents,
    enterpriseConnections: api.enterpriseConnections,
    trustedDevices: devices.trustedDevices,
    operatorSessions: devices.operatorSessions,
    deviceCodes: devices.deviceCodes,
    auditLogs: api.auditLogs,
  };
}

export type Schema = ReturnType<typeof defineSchema>;
export const TABLE_NAMES = [
  "instance","signingKeys","users","emailAddresses","phoneNumbers","externalAccounts","passkeys","clients","sessions","signIns","signUps","verifications","oauthStates","rateLimits","organizations","roles","permissions","rolePermissions","userRoles","organizationMemberships","organizationInvitations","organizationDomains","organizationMembershipRequests","invitations","waitlistEntries","allowlistIdentifiers","blocklistIdentifiers","jwtTemplates","actorTokens","signInTokens","webhookEndpoints","webhookEvents","webhookDeliveries","apiKeys","machines","m2mTokens","oauthApplications","oauthGrants","oauthConsents","enterpriseConnections","trustedDevices","operatorSessions","deviceCodes","auditLogs",
] as const;
