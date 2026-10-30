import type { Kit } from "../kit";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";
import type { IdentityTables } from "./identity";

export type TokensTables = ReturnType<typeof tokensTables>;

export function tokensTables(kit: Kit, users: IdentityTables["users"]) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

  const jwtTemplates = table("jwt_templates", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    /** claims with shortcodes e.g. { "email": "{{user.primary_email_address}}", "org": "{{org.slug}}" } */
    claims: json<Record<string, unknown>>("claims").notNull(),
    lifetime: int("lifetime").notNull().default(60),
    allowedClockSkew: int("allowed_clock_skew").notNull().default(5),
    customSigningKey: bool("custom_signing_key").notNull().default(false),
    signingAlgorithm: text("signing_algorithm").notNull().default("RS256"),
    signingKeyEnc: text("signing_key_enc"),
    ...created(),
  });
  const actorTokens = table("actor_tokens", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actor: json<Record<string, unknown>>("actor").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    expiresAt: int("expires_at").notNull(),
    sessionMaxDurationSeconds: int("session_max_duration_seconds").notNull().default(1800),
    ...created(),
  });
  const signInTokens = table("sign_in_tokens", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    expiresAt: int("expires_at").notNull(),
    ...created(),
  });

  return { jwtTemplates, actorTokens, signInTokens };
}
