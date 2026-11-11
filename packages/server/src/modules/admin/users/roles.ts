/** User roles, OAuth tokens, memberships, and trusted-device routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../../context";
import { and, count, eq, or } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../../lib/http";
import * as s from "../../../db/schema";
import { serializeMembership, serializeTrustedDevice, serializeUser } from "../../../serializers";
import { emitEvent } from "../../../services/webhooks";
import { audit } from "../../../services/audit";
import { listTrustedDevices, revokeTrustedDevice } from "../../../services/trusted-devices";
import { roleClaimsForUser, setUserRoles } from "../../../services/user-roles";
import { deleted, getUserOrThrow, listParams, page, refuseUserCredentialMutation } from "../shared";
import { first } from "../../../lib/db";
import { AUDIT_ACTOR } from "./shared";

export function registerRoleRoutes(app: Hono, ctx: AppContext) {
  app.get("/users/:id/oauth_access_tokens/:provider", async (c) => {
    await getUserOrThrow(ctx, c.req.param("id"));
    // Reading a user's third-party access token lets the operator act as them at the provider (post, read mail,
    // change the account). Nothing in the console needs the plaintext; the user reads their own token from their
    // signed-in session, where the OAuth grant was made.
    refuseUserCredentialMutation(
      "read a user's linked third-party access token",
      "GET /me/external_accounts/:id/access_token from their signed-in session",
    );
  });

  app.get("/users/:id/roles", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const claims = await roleClaimsForUser(ctx, existing.id);
    return c.json({
      object: "user_roles",
      user_id: existing.id,
      roles: claims.roles,
      role_permissions: claims.permissions,
    });
  });

  /**
   * Replaces a user's instance roles. Operator-only by construction: it lives under the Backend API, which
   * accepts the secret key or the dashboard's operator session. The Frontend API never exposes it, and no
   * request body, metadata or client state can reach `user_roles`. Organization roles are refused here.
   */
  app.put("/users/:id/roles", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const body = await parseBody(c, z.object({ roles: z.array(z.string().min(1)).max(50) }));
    const roles = await setUserRoles(ctx, existing.id, body.roles);
    // A role change is identity data, and instance roles are read from `user_roles` on every token mint, so the
    // change applies to the next token (≤ `session.tokenLifetimeSeconds`, 60 s by default) without ending the
    // user's sessions. Ending them here would sign the user out of every device for a permission change.
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.roles.updated", targetType: "user", targetId: existing.id, metadata: { roles } });
    const claims = await roleClaimsForUser(ctx, existing.id);
    return c.json({ object: "user_roles", user_id: existing.id, roles: claims.roles, role_permissions: claims.permissions });
  });

  app.get("/users/:id/organization_memberships", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const { limit, offset } = listParams(c);
    const where = eq(s.organizationMemberships.userId, existing.id);
    const rows = (await ctx.db.select().from(s.organizationMemberships).where(where).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.organizationMemberships).where(where))?.n ?? 0);
    return c.json(page((await Promise.all(rows.map((row) => serializeMembership(ctx, row, { backend: true })))), total));
  });

  app.get("/users/:id/trusted_devices", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    return c.json((await listTrustedDevices(ctx, existing.id)).map(serializeTrustedDevice));
  });

  app.delete("/users/:id/trusted_devices/:device_id", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    const row = await revokeTrustedDevice(ctx, existing.id, c.req.param("device_id") ?? "");
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Trusted device not found.");
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.trusted_device.revoked", targetType: "user", targetId: existing.id, metadata: { trusted_device_id: row.id } });
    return c.json(deleted("trusted_device", row.id));
  });

  return app;
}
