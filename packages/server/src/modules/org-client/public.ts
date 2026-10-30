/** Public logo files and invitation acceptance links. */
import type { Hono } from "hono";
import type { AppContext } from "../../context";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import * as s from "../../db/schema";
import { sha256 } from "../../lib/crypto";
import { validateRedirectUrl } from "../auth/redirects";
import { acceptInvitation } from "../../services/orgs";
import { userVerifiedEmails } from "../../services/org-domains";
import { tryResolveCaller } from "../orgs/auth";
import { logoContentType, uploadDir } from "../orgs/assets";
import { first } from "../../lib/db";

export function registerPublicRoutes(app: Hono, ctx: AppContext) {
  // ─────────── public: logo files ───────────
  app.get("/organization_logos/:file", (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes("..")) return c.json({ errors: [{ code: ErrorCodes.resource_not_found, message: "Not found" }] }, 404);
    try {
      const bytes = readFileSync(resolve(uploadDir(ctx), file));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": logoContentType(file),
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.json({ errors: [{ code: ErrorCodes.resource_not_found, message: "Not found" }] }, 404);
    }
  });

  // ─────────── public: invitation acceptance link (from the invitation email) ───────────
  app.get("/organization_invitations/accept", async (c) => {
    const ticket = c.req.query("ticket");
    if (!ticket) throw new OrbitError(400, ErrorCodes.form_param_missing, "ticket is missing", { param_name: "ticket" });
    const invitation = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.tokenHash, sha256(ticket))));
    if (!invitation) throw new OrbitError(422, ErrorCodes.ticket_invalid, "Organization invitation ticket is invalid");
    if (invitation.status === "revoked") throw new OrbitError(422, ErrorCodes.ticket_invalid, "Organization invitation has been revoked");
    if (invitation.status === "pending") {
      if (invitation.expiresAt && invitation.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.ticket_expired, "Organization invitation has expired");
      const caller = await tryResolveCaller(ctx, c);
      if (caller && (await userVerifiedEmails(ctx, caller.userId)).includes(invitation.email.toLowerCase())) {
        await acceptInvitation(ctx, invitation, caller.userId);
      }
    }
    const requested = validateRedirectUrl(ctx, c.req.query("redirect_url") || invitation.redirectUrl);
    const target = new URL(requested ?? (ctx.settings.get().application.homeUrl || ctx.env.baseUrl));
    // No `__orbit_ticket` here: the SDK would present it as a sign-in ticket, which it is not. A signed-out invitee
    // signs up or in normally, and verifying the invited address joins the organization.
    return c.redirect(target.toString(), 302);
  });
}
