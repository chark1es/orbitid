/** OAuth 2.0 / OpenID Connect provider routes: discovery, authorization, tokens, device grant, and management. */
import { Hono } from "hono";
import type { AppContext } from "../context";
import { registerDiscoveryRoutes } from "./oidc/discovery";
import { registerTokenRoutes } from "./oidc/token";
import { registerDeviceRoutes } from "./oidc/device";
import { registerMachineRoutes } from "./oidc/machine";
import { registerApplicationRoutes } from "./oidc/applications";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  registerDiscoveryRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerDeviceRoutes(app, ctx);
  registerMachineRoutes(app, ctx);
  registerApplicationRoutes(app, ctx);

  return app;
}
