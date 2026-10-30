import type { Kit } from "../kit";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";

export type IdentityTables = ReturnType<typeof identityTables>;

export function identityTables(kit: Kit) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

  const instance = table("instance", {
    id: text("id").primaryKey(),
    settings: json<Record<string, unknown>>("settings").notNull(),
    secretKeyHash: text("secret_key_hash"),
    ...created(),
  });

  /** JWT signing keys; private JWK encrypted at rest with ORBITID_ENCRYPTION_KEY (AES-256-GCM). */
  const signingKeys = table("signing_keys", {
    kid: text("kid").primaryKey(),
    alg: text("alg").notNull(),
    publicJwk: json<Record<string, unknown>>("public_jwk").notNull(),
    privateJwkEnc: text("private_jwk_enc").notNull(),
    active: bool("active").notNull().default(true),
    createdAt: ts("created_at"),
    rotatedAt: int("rotated_at"),
  });

  // ───────────── users & identifications ─────────────
  const users = table("users", {
    id: text("id").primaryKey(),
    externalId: text("external_id").unique(),
    username: text("username"),
    usernameLower: text("username_lower").unique(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    imageUrl: text("image_url"),
    hasImage: bool("has_image").notNull().default(false),
    passwordHash: text("password_hash"),
    passwordUpdatedAt: int("password_updated_at"),
    primaryEmailAddressId: text("primary_email_address_id"),
    primaryPhoneNumberId: text("primary_phone_number_id"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    unsafeMetadata: json<Meta>("unsafe_metadata").notNull().$defaultFn(() => ({})),
    banned: bool("banned").notNull().default(false),
    locked: bool("locked").notNull().default(false),
    lockoutExpiresAt: int("lockout_expires_at"),
    failedAttempts: int("failed_attempts").notNull().default(0),
    // MFA
    totpSecretEnc: text("totp_secret_enc"),
    totpVerified: bool("totp_verified").notNull().default(false),
    /** sha256 hashes of unused backup codes */
    backupCodes: json<string[]>("backup_codes"),
    /** Guest account created without credentials; becomes a regular user once an identifier is attached. */
    isAnonymous: bool("is_anonymous").notNull().default(false),
    deleteSelfEnabled: bool("delete_self_enabled").notNull().default(true),
    createOrganizationEnabled: bool("create_organization_enabled").notNull().default(true),
    createOrganizationsLimit: int("create_organizations_limit"),
    legalAcceptedAt: int("legal_accepted_at"),
    lastSignInAt: int("last_sign_in_at"),
    lastActiveAt: int("last_active_at"),
    ...created(),
  });

  const emailAddresses = table("email_addresses", {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // stored lowercased
    verified: bool("verified").notNull().default(false),
    verifiedAt: int("verified_at"),
    verifiedStrategy: text("verified_strategy"),
    reserved: bool("reserved").notNull().default(false),
    ...created(),
  }, (t) => [uniqueIndex("email_unique_verified").on(t.email).where(sql`${t.verified} = true`), index("email_user_idx").on(t.userId), index("email_addr_idx").on(t.email)]);

  const phoneNumbers = table("phone_numbers", {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(), // E.164
    verified: bool("verified").notNull().default(false),
    verifiedAt: int("verified_at"),
    reservedForSecondFactor: bool("reserved_for_second_factor").notNull().default(false),
    defaultSecondFactor: bool("default_second_factor").notNull().default(false),
    ...created(),
  }, (t) => [uniqueIndex("phone_unique_verified").on(t.phone).where(sql`${t.verified} = true`), index("phone_user_idx").on(t.userId)]);

  const externalAccounts = table("external_accounts", {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    emailAddress: text("email_address").notNull().default(""),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    username: text("username"),
    imageUrl: text("image_url"),
    approvedScopes: text("approved_scopes").notNull().default(""),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: int("token_expires_at"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    ...created(),
  }, (t) => [uniqueIndex("ext_provider_uid").on(t.provider, t.providerUserId), index("ext_user_idx").on(t.userId)]);

  const passkeys = table("passkeys", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    credentialId: text("credential_id").notNull().unique(), // base64url
    publicKey: text("public_key").notNull(), // base64url COSE key
    counter: int("counter").notNull().default(0),
    transports: json<string[]>("transports"),
    deviceType: text("device_type"),
    backedUp: bool("backed_up").notNull().default(false),
    lastUsedAt: int("last_used_at"),
    ...created(),
  });

  return { instance, signingKeys, users, emailAddresses, phoneNumbers, externalAccounts, passkeys };
}
