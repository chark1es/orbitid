/**
 * Signed-in user routes (`/v1/client/me/*`): profile, identifiers, external accounts, MFA, passkeys,
 * sessions, and trusted devices.
 *
 * Handlers are grouped in `./me/*`; session/response helpers live in `./me/helpers.ts`.
 */
import { Hono } from "hono";
import type { AppContext } from "../context";
import { createMeHelpers } from "./me/helpers";
import { registerProfileRoutes } from "./me/profile";
import { registerIdentifierRoutes } from "./me/identifiers";
import { registerExternalAccountRoutes } from "./me/external";
import { registerMfaRoutes } from "./me/mfa";
import { registerPasskeyRoutes } from "./me/passkeys";
import { registerSessionRoutes } from "./me/sessions";

export default function routes(ctx: AppContext) {
  const app = new Hono();
  const helpers = createMeHelpers(ctx);

  registerProfileRoutes(app, ctx, helpers);
  registerIdentifierRoutes(app, ctx, helpers);
  registerExternalAccountRoutes(app, ctx, helpers);
  registerMfaRoutes(app, ctx, helpers);
  registerPasskeyRoutes(app, ctx, helpers);
  registerSessionRoutes(app, ctx, helpers);

  return app;
}
