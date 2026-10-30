/**
 * Organization Backend API (`/v1/organizations/*`, `/v1/roles`, `/v1/permissions`).
 *
 * Note: this module is the operator surface (secret key or dashboard session), so it deliberately keeps working
 * while `organizations.enabled` is false — an operator can still inspect and repair data, and an import or
 * migration does not depend on a product switch. The user-facing lock lives on the Frontend API routes and on
 * every path that mints a membership for a signed-in user (see `assertCanCreateOrganization`, `orgAccess`).
 *
 * Handlers are grouped in `./org-backend/*`.
 */
import { Hono } from "hono";
import type { AppContext } from "../context";
import { registerOrganizationRoutes } from "./org-backend/organizations";
import { registerMembershipRoutes } from "./org-backend/memberships";
import { registerInvitationRoutes } from "./org-backend/invitations";
import { registerDomainRoutes } from "./org-backend/domains";
import { registerRequestRoutes } from "./org-backend/requests";
import { registerRoleRoutes } from "./org-backend/roles";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  registerOrganizationRoutes(app, ctx);
  registerMembershipRoutes(app, ctx);
  registerInvitationRoutes(app, ctx);
  registerDomainRoutes(app, ctx);
  registerRequestRoutes(app, ctx);
  registerRoleRoutes(app, ctx);

  return app;
}
