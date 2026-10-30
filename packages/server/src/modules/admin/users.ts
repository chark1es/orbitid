/** Admin user management routes; handlers are grouped in `./users/*`. */
import { Hono } from "hono";
import type { AppContext } from "../../context";
import { registerListRoutes } from "./users/list";
import { registerCreateRoutes } from "./users/create";
import { registerUpdateRoutes } from "./users/update";
import { registerModerationRoutes } from "./users/moderation";
import { registerImageRoutes } from "./users/images";
import { registerRoleRoutes } from "./users/roles";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  registerListRoutes(app, ctx);
  registerCreateRoutes(app, ctx);
  registerUpdateRoutes(app, ctx);
  registerModerationRoutes(app, ctx);
  registerImageRoutes(app, ctx);
  registerRoleRoutes(app, ctx);

  return app;
}
