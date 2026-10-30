// Backend API one-time sign-in tokens.
//
// The ability to mint a session as another user was removed. Both paths that existed are gone:
//
// - actor (impersonation) tokens, which carried an `act` claim and bypassed the user's MFA;
// - sign-in tokens, which minted a session for whatever `user_id` the operator named.
//
// A credential held by an operator (or by anyone who obtains the instance secret key) must not be redeemable
// for somebody else's session through the Frontend API: that is impersonation regardless of the claim it
// leaves behind, and it silently defeats the user's password, second factor and trusted-device policy.
//
// The routes stay mounted so an existing integration gets a clear, typed refusal instead of a confusing 404,
// and historical `sessions.actor` values are still serialized for the dashboard's activity view.
import { Hono } from "hono";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";

const refusal = () => new OrbitError(
  403,
  ErrorCodes.not_allowed_access,
  "Impersonation and one-time sign-in tokens were removed. An operator cannot mint a session for another user. " +
    "Ask the user to sign in, or send them a password-reset or invitation email.",
);

export default function routes(_ctx: AppContext) {
  const app = new Hono();

  // Both the collection and the revoke routes answer the same way: nothing here can create or affect a session.
  app.post("/sign_in_tokens", () => { throw refusal(); });
  app.post("/sign_in_tokens/:id/revoke", () => { throw refusal(); });
  app.post("/actor_tokens", () => { throw refusal(); });
  app.post("/actor_tokens/:id/revoke", () => { throw refusal(); });

  return app;
}
