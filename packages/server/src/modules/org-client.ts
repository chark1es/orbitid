/**
 * Organization Frontend API (`/v1/client/organizations/*` and the signed-in user's own memberships).
 *
 * Handlers are grouped in `./org-client/*`.
 */
import { Hono } from "hono";
import type { AppContext } from "../context";
import { registerPublicRoutes } from "./org-client/public";
import { registerCurrentUserRoutes } from "./org-client/current-user";
import { registerOrganizationRoutes } from "./org-client/organizations";
import { registerMembershipRoutes } from "./org-client/memberships";
import { registerInvitationRoutes } from "./org-client/invitations";
import { registerDomainRoutes } from "./org-client/domains";
import { registerRequestRoutes } from "./org-client/requests";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  registerPublicRoutes(app, ctx);
  registerCurrentUserRoutes(app, ctx);
  registerOrganizationRoutes(app, ctx);
  registerMembershipRoutes(app, ctx);
  registerInvitationRoutes(app, ctx);
  registerDomainRoutes(app, ctx);
  registerRequestRoutes(app, ctx);

  return app;
}
