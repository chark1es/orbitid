// OWNER: worker "core" (W1) — /v1/verify (magic-link landing)
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { clientIp } from "../lib/http";
import { getUserById } from "../services/users";
import { consumeLink, getVerificationByToken } from "./auth/verifications";
import { afterFirstFactor, asSignInState, assertSignInAllowed, saveSignInState } from "./auth/signin-core";
import { asSignUpVerifications, maybeCompleteSignUp, saveSignUp } from "./auth/signup-core";
import { validateRedirectUrl, withQuery } from "./auth/redirects";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/", async (c) => {
    const token = c.req.query("token");
    if (!token) throw new OrbitError(400, ErrorCodes.form_param_missing, "token is missing", { param_name: "token" });
    const home = validateRedirectUrl(ctx, c.req.query("redirect_url")) ?? ctx.settings.get().application.homeUrl;
    const row = getVerificationByToken(ctx, token);
    if (!row) return c.redirect(withQuery(home, { __orbit_status: "failed" }), 302);
    const target = row.redirectUrl ?? home;
    if (row.expiresAt <= Date.now() && !row.verifiedAt) {
      return c.redirect(withQuery(target, { __orbit_status: "expired" }), 302);
    }
    if (row.verifiedAt || row.consumedAt) {
      return c.redirect(withQuery(target, { __orbit_status: "verified" }), 302);
    }
    consumeLink(ctx, row);

    // Advance the owning flow server-side so the originating device's polling observes it.
    try {
      if (row.purpose === "sign_in_first_factor") {
        const signIn = ctx.db.select().from(s.signIns).where(eq(s.signIns.id, row.ownerId)).get();
        if (signIn && signIn.status !== "complete" && signIn.status !== "abandoned" && signIn.userId) {
          const user = getUserById(ctx, signIn.userId);
          if (user) {
            assertSignInAllowed(user);
            const state = asSignInState(signIn);
            saveSignInState(ctx, signIn, { ...state, first: { strategy: row.strategy, status: "verified", verificationId: row.id } });
            ctx.db.update(s.signIns).set({ updatedAt: Date.now() }).where(eq(s.signIns.id, signIn.id)).run();
            const fresh = ctx.db.select().from(s.signIns).where(eq(s.signIns.id, signIn.id)).get()!;
            await afterFirstFactor(ctx, fresh, user, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
          }
        }
      } else if (row.purpose === "sign_up_email") {
        const signUp = ctx.db.select().from(s.signUps).where(eq(s.signUps.id, row.ownerId)).get();
        if (signUp && signUp.status !== "complete" && signUp.status !== "abandoned") {
          const verifications = asSignUpVerifications(signUp);
          const snapshot = verifications.email_address ?? { status: "unverified", strategy: row.strategy, identifier: row.identifier };
          saveSignUp(ctx, signUp, {
            verifications: {
              ...verifications,
              email_address: { ...snapshot, status: "verified", strategy: row.strategy, verificationId: row.id },
            },
          });
          const fresh = ctx.db.select().from(s.signUps).where(eq(s.signUps.id, signUp.id)).get()!;
          await maybeCompleteSignUp(ctx, fresh, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? undefined });
        }
      }
    } catch {
      return c.redirect(withQuery(target, { __orbit_status: "failed" }), 302);
    }

    return c.redirect(withQuery(target, { __orbit_status: "verified" }), 302);
  });

  return app;
}
