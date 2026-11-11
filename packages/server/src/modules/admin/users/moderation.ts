/** User deletion, bans, locks, verification, and credential refusal routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../../context";
import { and, eq, exists } from "drizzle-orm";
import * as s from "../../../db/schema";
import { serializeUser } from "../../../serializers";
import { emitEvent } from "../../../services/webhooks";
import { audit } from "../../../services/audit";
import { onUserDeleted } from "../../../services/orgs";
import { revokeAllTrustedDevices } from "../../../services/trusted-devices";
import { revokeApiKeysForSubject } from "../../../services/api-keys";
import { revokeGrantsForUser } from "../../../services/oidc/revocation";
import { deleted, getUserOrThrow, refuseUserCredentialMutation } from "../shared";
import { revokeSessions, AUDIT_ACTOR } from "./shared";

export function registerModerationRoutes(app: Hono, ctx: AppContext) {
  app.delete("/users/:id", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const payload = { ...await serializeUser(ctx, existing, { backend: true }), deleted: true as const };
    // Runs while the row still exists so membership/org webhook payloads can be serialized.
    await onUserDeleted(ctx, existing.id);
    await ctx.db.delete(s.users).where(eq(s.users.id, existing.id));
    await emitEvent(ctx, "user.deleted", payload);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.deleted", targetType: "user", targetId: existing.id });
    return c.json(deleted("user", existing.id));
  });

  app.post("/users/:id/ban", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    await ctx.db.update(s.users).set({ banned: true, updatedAt: Date.now() }).where(eq(s.users.id, existing.id));
    await revokeSessions(ctx, existing.id);
    await revokeGrantsForUser(ctx, existing.id);
    await revokeAllTrustedDevices(ctx, existing.id);
    await revokeApiKeysForSubject(ctx, existing.id, "user banned");
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.banned", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/unban", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    await ctx.db.update(s.users).set({ banned: false, updatedAt: Date.now() }).where(eq(s.users.id, existing.id));
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.unbanned", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/lock", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    await ctx.db.update(s.users).set({ locked: true, lockoutExpiresAt: null, updatedAt: Date.now() }).where(eq(s.users.id, existing.id));
    await revokeAllTrustedDevices(ctx, existing.id);
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.locked", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/unlock", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    await ctx.db.update(s.users).set({ locked: false, lockoutExpiresAt: null, failedAttempts: 0, updatedAt: Date.now() }).where(eq(s.users.id, existing.id));
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.unlocked", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.post("/users/:id/verify_password", async (c) => {
    await getUserOrThrow(ctx, c.req.param("id"));
    // A Backend check runs outside the sign-in lockout and rate limiter, so it would be an unmetered password
    // oracle for any account whose id an operator can list: guessing, not administration.
    refuseUserCredentialMutation(
      "verify a user's password outside sign-in",
      "the sign-in flow, which counts failures and locks the account",
    );
  });

  app.post("/users/:id/verify_totp", async (c) => {
    await getUserOrThrow(ctx, c.req.param("id"));
    // Same reasoning, and worse: a six-digit code lives for 30 seconds, so an unmetered endpoint turns TOTP into
    // something to brute force instead of a second factor to possess.
    refuseUserCredentialMutation(
      "verify a user's authenticator code outside sign-in",
      "the sign-in flow, which counts failures and locks the account",
    );
  });

  app.delete("/users/:id/mfa", async (c) => {
    await getUserOrThrow(ctx, c.req.param("id"));
    // Clearing the second factor is the classic "reset it so I can get in" step. The user does it themselves from
    // their own session; an operator doing it would turn a protected account into one they can sign in to.
    refuseUserCredentialMutation(
      "reset the user's second factor",
      "DELETE /totp and DELETE /phone_numbers/:id from their signed-in session",
    );
  });

  app.delete("/users/:id/password", async (c) => {
    await getUserOrThrow(ctx, c.req.param("id"));
    refuseUserCredentialMutation(
      "remove the user's password",
      "POST /remove_password from their signed-in session",
    );
  });
}
