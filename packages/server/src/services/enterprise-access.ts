// Enterprise-connection policy for an already-linked user: extra identifications and attribute sync.
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { first } from "../lib/db";
import type { ExternalProfile } from "./external-identity";

type ConnectionRow = typeof s.enterpriseConnections.$inferSelect;

const PROVIDER_PREFIXES = ["saml_", "oidc_", "enterprise_saml_", "enterprise_oidc_"] as const;

/** `saml_ent_...` / `oidc_ent_...` → the connection id, or undefined for a social provider. */
export function enterpriseConnectionIdFromProvider(provider: string): string | undefined {
  for (const prefix of PROVIDER_PREFIXES) {
    if (provider.startsWith(prefix)) return provider.slice(prefix.length);
  }
  return undefined;
}

/** Every enterprise connection a user is linked to (one external account per connection is enough). */
export async function enterpriseConnectionsForUser(ctx: AppContext, userId: string): Promise<ConnectionRow[]> {
  const accounts = await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, userId));
  const connections: ConnectionRow[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const connectionId = enterpriseConnectionIdFromProvider(account.provider);
    if (!connectionId || seen.has(connectionId)) continue;
    seen.add(connectionId);
    const connection = first(await ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, connectionId)));
    if (connection) connections.push(connection);
  }
  return connections;
}

/** The first enterprise connection a user signed in through, if any. */
export async function enterpriseConnectionForUser(ctx: AppContext, userId: string): Promise<ConnectionRow | undefined> {
  return (await enterpriseConnectionsForUser(ctx, userId))[0];
}

/**
 * `disable_additional_identifications` belongs to every connection the user belongs to, not to the current browser
 * or only the first link. If ANY of them forbids additions, the addition is refused.
 */
export async function assertAdditionalIdentificationsAllowed(ctx: AppContext, userId: string): Promise<void> {
  const connection = (await enterpriseConnectionsForUser(ctx, userId)).find((row) => row.disableAdditionalIdentifications);
  if (!connection) return;
  throw new OrbitError(
    403,
    ErrorCodes.not_allowed_access,
    "Additional identifications are disabled for your enterprise connection",
    { enterprise_connection_id: connection.id },
  );
}

/**
 * `sync_user_attributes`: keep the local name and avatar aligned with the identity provider on each SSO sign-in.
 * Only fields the provider actually supplied are overwritten; a missing claim never clears a local value.
 */
export async function syncEnterpriseUserAttributes(ctx: AppContext, userId: string, profile: ExternalProfile): Promise<void> {
  const connectionId = enterpriseConnectionIdFromProvider(profile.provider);
  if (!connectionId) return;
  const connection = first(await ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, connectionId)));
  if (!connection?.syncUserAttributes) return;
  const patch: Partial<typeof s.users.$inferInsert> = {};
  if (profile.firstName) patch.firstName = profile.firstName;
  if (profile.lastName) patch.lastName = profile.lastName;
  if (profile.imageUrl) {
    patch.imageUrl = profile.imageUrl;
    patch.hasImage = false; // a remote avatar, not a locally uploaded (and served) file
  }
  if (!Object.keys(patch).length) return;
  patch.updatedAt = Date.now();
  await ctx.db.update(s.users).set(patch).where(eq(s.users.id, userId));
}
