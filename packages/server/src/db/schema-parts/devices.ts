import type { Kit } from "../kit";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";
import type { IdentityTables } from "./identity";
import type { ApiTables } from "./api";

export type DevicesTables = ReturnType<typeof devicesTables>;

export function devicesTables(kit: Kit, users: IdentityTables["users"], oauthApplications: ApiTables["oauthApplications"]) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

  const trustedDevices = table("trusted_devices", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label"),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: int("expires_at").notNull(),
    lastUsedAt: int("last_used_at"),
    revokedAt: int("revoked_at"),
    ...created(),
  }, (t) => [index("trusted_devices_user_idx").on(t.userId)]);

  /**
   * Dashboard operator sessions. The secret key is exchanged once for an opaque token that lives in an
   * httpOnly cookie; only its sha256 is stored, so the database cannot mint a session and a compromised
   * cookie can be revoked immediately. `keyFingerprint` binds the session to the secret key it was
   * approved with, so rotating the key signs every operator out.
   */
  const operatorSessions = table("operator_sessions", {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    keyFingerprint: text("key_fingerprint").notNull(),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: int("expires_at").notNull(),
    revokedAt: int("revoked_at"),
    ...created(),
  }, (t) => [index("operator_sessions_expires_idx").on(t.expiresAt)]);

  /** OAuth 2.0 device authorization grant (RFC 8628): a CLI or TV polls with `deviceCodeHash` while the user approves `userCode` in a browser. */
  const deviceCodes = table("device_codes", {
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull().references(() => oauthApplications.id, { onDelete: "cascade" }),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    /** Short code the user types, stored upper-case without separators. */
    userCode: text("user_code").notNull().unique(),
    scopes: text("scopes").notNull(),
    /** pending | approved | denied | consumed */
    status: text("status").notNull().default("pending"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    intervalSeconds: int("interval_seconds").notNull().default(5),
    lastPolledAt: int("last_polled_at"),
    expiresAt: int("expires_at").notNull(),
    createdAt: ts("created_at"),
  });

  return { trustedDevices, operatorSessions, deviceCodes };
}
