/** Dashboard operator sessions: exchanging the instance secret key for an httpOnly, revocable cookie. */
import { ref } from "../schema";
import { op, Tags, type DocumentedOperation } from "../operation";

export const operatorSessionPaths: DocumentedOperation[] = [
  op("post", "/v1/operator_sessions", Tags.dashboard, "createOperatorSession", "Sign in to the dashboard with the secret key", {
    security: "none",
    description:
      "The one place a browser may present the instance secret key. The key is compared in constant time and rate " +
      "limited per address, then replaced by an opaque session token in an httpOnly cookie; the key is neither " +
      "stored nor returned. Requires the request to come from this instance's own origin, and answers `429` with " +
      "`Retry-After` after too many failed attempts.",
    body: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["secret_key"],
        properties: {
          secret_key: { type: "string", description: "The instance secret key (`sk_live_…` / `sk_test_…`).", writeOnly: true },
        },
      },
      description: "The secret key. It travels once and is never echoed in the response.",
    },
    success: {
      status: 201,
      schema: ref("OperatorSession"),
      description: "Sets the `__orbit_operator` cookie and returns the session's id and expiry.",
      headers: {
        "Set-Cookie": { type: "string", description: "`__orbit_operator=<opaque>; Path=/v1; HttpOnly; SameSite=Strict` (plus `Secure` over https)." },
      },
    },
    errors: [401, 403, 429],
  }),
  op("get", "/v1/operator_sessions/current", Tags.dashboard, "getCurrentOperatorSession", "Check the dashboard session", {
    security: "none",    description:
      "Reports whether this browser still has a live operator session. Used on dashboard load so an expired or " +
      "revoked cookie sends the operator to the sign-in screen. Answers `401` and clears the cookie when there is none.",
    success: { status: 200, schema: ref("OperatorSession") },
    errors: [401, 403],
  }),
  op("delete", "/v1/operator_sessions/current", Tags.dashboard, "revokeOperatorSession", "Sign out of the dashboard", {
    security: "none",
    description: "Revokes this browser's operator session and clears the cookie. Safe to call without a session.",
    success: { status: 204, description: "The session is revoked and the cookie cleared." },
    errors: [403],
  }),
];
