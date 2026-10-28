import type { MiddlewareHandler } from "hono";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import type { AppContext } from "./context";
import { safeEqual } from "./lib/crypto";

/** Backend API auth: `Authorization: Bearer sk_...` must equal env secret key. */
export const requireSecretKey = (ctx: AppContext): MiddlewareHandler => async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || !safeEqual(token, ctx.env.secretKey)) throw new OrbitError(401, ErrorCodes.secret_key_invalid, "Invalid secret key");
  await next();
};
