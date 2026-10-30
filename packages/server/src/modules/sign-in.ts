/**
 * Sign-in routes: identifier resolution, first and second factors, and password reset.
 *
 * Handlers are grouped in `./sign-in/*`; shared state and response helpers live in `./sign-in/helpers.ts`.
 */
import { Hono } from "hono";
import type { AppContext } from "../context";
import { registerCreationRoutes } from "./sign-in/creation";
import { registerFirstFactorRoutes } from "./sign-in/first-factor";
import { registerSecondFactorRoutes } from "./sign-in/second-factor";
import { createSignInHelpers } from "./sign-in/helpers";

export { spendPasswordCheck } from "./sign-in/shared";

export default function routes(ctx: AppContext) {
  const app = new Hono();
  const helpers = createSignInHelpers(ctx);

  registerCreationRoutes(app, ctx, helpers);
  registerFirstFactorRoutes(app, ctx, helpers);
  registerSecondFactorRoutes(app, ctx, helpers);

  return app;
}
