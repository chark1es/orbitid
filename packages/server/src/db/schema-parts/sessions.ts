import type { Kit } from "../kit";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";
import type { IdentityTables } from "./identity";

export type SessionsTables = ReturnType<typeof sessionsTables>;

export function sessionsTables(kit: Kit, users: IdentityTables["users"]) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

  const clients = table("clients", {
    id: text("id").primaryKey(),
    /** sha256 of the opaque `__client` cookie value */
    tokenHash: text("token_hash").notNull().unique(),
    lastActiveSessionId: text("last_active_session_id"),
    /** When the current opaque `__client` token was issued (epoch ms), so a durable cookie can be re-issued. */
    tokenIssuedAt: int("token_issued_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    ...created(),
  });

  const sessions = table("sessions", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    lastActiveAt: ts("last_active_at"),
    lastActiveOrganizationId: text("last_active_organization_id"),
    expireAt: int("expire_at").notNull(),
    abandonAt: int("abandon_at").notNull(),
    actor: json<Record<string, unknown>>("actor"),
    /** epoch ms of last successful first/second factor verification (reverification) */
    firstFactorVerifiedAt: int("first_factor_verified_at"),
    secondFactorVerifiedAt: int("second_factor_verified_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    city: text("city"),
    country: text("country"),
    /** One of AuthMethod from @orbitid/shared. */
    authMethod: text("auth_method"),
    ...created(),
  }, (t) => [index("sess_user_idx").on(t.userId), index("sess_client_idx").on(t.clientId)]);

  const signIns = table("sign_ins", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    identifier: text("identifier"),
    userId: text("user_id"),
    /** serialized verification state: { first: VerificationJSON-ish + internal, second: ... , passwordResetPending: bool } */
    state: json<Record<string, unknown>>("state").notNull().$defaultFn(() => ({})),
    createdSessionId: text("created_session_id"),
    abandonAt: int("abandon_at").notNull(),
    ...created(),
  });

  const signUps = table("sign_ups", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    /** collected fields: emailAddress, phoneNumber, username, firstName, lastName, passwordHash, externalId, legalAcceptedAt, externalAccount{...} */
    fields: json<Record<string, unknown>>("fields").notNull().$defaultFn(() => ({})),
    unsafeMetadata: json<Meta>("unsafe_metadata").notNull().$defaultFn(() => ({})),
    /** per-field verification state: { email_address: {...}, phone_number: {...}, external_account: {...} } */
    verifications: json<Record<string, unknown>>("verifications").notNull().$defaultFn(() => ({})),
    invitationId: text("invitation_id"),
    orgInvitationId: text("org_invitation_id"),
    createdSessionId: text("created_session_id"),
    createdUserId: text("created_user_id"),
    abandonAt: int("abandon_at").notNull(),
    ...created(),
  });

  /** One-time codes / magic-link tokens / tickets, hashed. */
  const verifications = table("verifications", {
    id: text("id").primaryKey(),
    /** e.g. sign_in_first_factor | sign_in_second_factor | sign_up_email | add_email | add_phone | reverify | reset_password | org_domain */
    purpose: text("purpose").notNull(),
    strategy: text("strategy").notNull(), // email_code | email_link | phone_code | ...
    identifier: text("identifier").notNull(), // email / phone the code was sent to
    /** resource that owns the attempt (sign_in id, sign_up id, email_address id, ...) */
    ownerId: text("owner_id").notNull(),
    codeHash: text("code_hash"),
    tokenHash: text("token_hash"),
    attempts: int("attempts").notNull().default(0),
    maxAttempts: int("max_attempts").notNull().default(5),
    redirectUrl: text("redirect_url"),
    /** extra state for the verification (passkey challenge/rpID/origin, email being verified, ...) */
    data: json<Record<string, unknown>>("data"),
    /** magic-link: set when link was clicked in any browser */
    consumedAt: int("consumed_at"),
    verifiedAt: int("verified_at"),
    expiresAt: int("expires_at").notNull(),
    createdAt: ts("created_at"),
  }, (t) => [index("ver_owner_idx").on(t.ownerId, t.purpose), index("ver_token_idx").on(t.tokenHash)]);

  /** In-flight OAuth authorizations (state → flow). */
  const oauthStates = table("oauth_states", {
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    codeVerifier: text("code_verifier"),
    nonce: text("nonce"),
    /** { kind: "sign_in"|"sign_up"|"connect", ownerId, userId?, redirectUrl, actionCompleteRedirectUrl, additionalScopes? } */
    flow: json<Record<string, unknown>>("flow").notNull(),
    expiresAt: int("expires_at").notNull(),
  });

  /** Sliding-window rate limit counters (also used for lockout of IPs). */
  const rateLimits = table("rate_limits", {
    key: text("key").primaryKey(),
    count: int("count").notNull(),
    resetAt: int("reset_at").notNull(),
  });

  return { clients, sessions, signIns, signUps, verifications, oauthStates, rateLimits };
}
