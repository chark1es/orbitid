// /v1/verify (magic-link landing)
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { clientIp } from "../lib/http";
import { getUserById } from "../services/users";
import { consumeLink, getVerificationByToken } from "./auth/verifications";
import { findClient, rotateClientTokenOnSignIn } from "./auth/client-auth";
import { afterFirstFactor, asSignInState, assertSignInAllowed, saveSignInState } from "./auth/signin-core";
import { asSignUpFields, asSignUpVerifications, maybeCompleteSignUp, saveSignUp } from "./auth/signup-core";
import { validateRedirectUrl, withQuery } from "./auth/redirects";
import { first } from "../lib/db";

export default function routes(ctx: AppContext) {
  const app = new Hono();

  app.get("/", async (c) => {
    const token = c.req.query("token");
    if (!token) throw new OrbitError(400, ErrorCodes.form_param_missing, "token is missing", { param_name: "token" });
    const home = validateRedirectUrl(ctx, c.req.query("redirect_url")) ?? ctx.settings.get().application.homeUrl;
    const row = await getVerificationByToken(ctx, token);
    if (!row) return c.redirect(withQuery(home, { __orbit_status: "failed" }), 302);
    const target = row.redirectUrl ?? home;
    if (row.expiresAt <= Date.now() && !row.verifiedAt) {
      return c.redirect(withQuery(target, { __orbit_status: "expired" }), 302);
    }
    if (row.verifiedAt || row.consumedAt) {
      return c.redirect(withQuery(target, { __orbit_status: "verified" }), 302);
    }
    // A link only completes a flow in the browser that started it. Otherwise anyone could start a sign-in or
    // sign-up for somebody else's address and have the real owner's click finish it for them.
    if (row.purpose === "sign_in_first_factor" || row.purpose === "sign_up_email") {
      const owner = row.purpose === "sign_in_first_factor"
        ? first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, row.ownerId)))
        : first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, row.ownerId)));
      const client = await findClient(ctx, c);
      if (!owner || !client || client.id !== owner.clientId) {
        return c.redirect(withQuery(target, { __orbit_status: "different_browser" }), 302);
      }
    }
    await consumeLink(ctx, row);

    // Advance the owning flow server-side so the originating device's polling observes it.
    try {
      if (row.purpose === "sign_in_first_factor") {
        const signIn = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, row.ownerId)));
        if (signIn && signIn.status !== "complete" && signIn.status !== "abandoned" && signIn.userId) {
          const user = await getUserById(ctx, signIn.userId);
          if (user) {
            assertSignInAllowed(user);
            const state = asSignInState(signIn);
            await saveSignInState(ctx, signIn, { ...state, first: { strategy: row.strategy, status: "verified", verificationId: row.id } });
            await ctx.db.update(s.signIns).set({ updatedAt: Date.now() }).where(eq(s.signIns.id, signIn.id));
            const fresh = first(await ctx.db.select().from(s.signIns).where(eq(s.signIns.id, signIn.id)))!;
            // The cookie the browser held before the link was opened must not stay valid for the new session.
            await afterFirstFactor(ctx, fresh, user, {
              ip: clientIp(c),
              userAgent: c.req.header("user-agent") ?? undefined,
              rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, fresh.clientId),
            });
          }
        }
      } else if (row.purpose === "sign_up_email") {
        const signUp = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, row.ownerId)));
        if (signUp && signUp.status !== "complete" && signUp.status !== "abandoned") {
          const verifications = asSignUpVerifications(signUp);
          // The link only vouches for the mailbox it was sent to, and only while it is the one on the sign-up.
          const current = verifications.email_address;
          if (asSignUpFields(signUp).emailAddress !== row.identifier || current?.verificationId !== row.id) {
            return c.redirect(withQuery(target, { __orbit_status: "failed" }), 302);
          }
          const snapshot = current;
          await saveSignUp(ctx, signUp, {
                        verifications: {
                          ...verifications,
                          email_address: { ...snapshot, status: "verified", strategy: row.strategy, verificationId: row.id },
                        },
                      });
          const fresh = first(await ctx.db.select().from(s.signUps).where(eq(s.signUps.id, signUp.id)))!;
          await maybeCompleteSignUp(ctx, fresh, {
            ip: clientIp(c),
            userAgent: c.req.header("user-agent") ?? undefined,
            rotateClientToken: () => rotateClientTokenOnSignIn(ctx, c, fresh.clientId),
          });
        }
      }
    } catch {
      return c.redirect(withQuery(target, { __orbit_status: "failed" }), 302);
    }

    return c.redirect(withQuery(target, { __orbit_status: "verified" }), 302);
  });

  return app;
}
