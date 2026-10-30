/** backend paths: sessions. */
import { arr, ref } from "../../schema";
import { backendListParams, idPath, op, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { list, ok } from "../common";

export const operations: DocumentedOperation[] = [
  // ───────────── sessions and clients ─────────────
  op("get", "/v1/sessions", "Sessions", "listSessions", "List sessions", {
    security: "backend",
    description: "Filters: `user_id`, `client_id`, `status`; `expired=false` keeps only sessions that have not expired.",
    parameters: [
      ...backendListParams,
      queryParam("user_id", { type: "string" }),
      queryParam("client_id", { type: "string" }),
      queryParam("status", { type: "string" }),
      queryParam("expired", { type: "string", enum: ["true", "false"] }),
    ],
    ...list(ref("Session")),
    errors: [429],
  }),
  op("get", "/v1/sessions/{id}", "Sessions", "getSession", "Read a session", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Session")),
    errors: [404],
  }),
  op("post", "/v1/sessions/{id}/revoke", "Sessions", "revokeSession", "Revoke a session", {
    security: "backend",
    description: "Marks the session revoked and emits `session.revoked`. Its tokens stop verifying.",
    parameters: [idPath],
    ...ok(ref("Session")),
    errors: [404],
  }),
  op("post", "/v1/sessions/{id}/verify", "Sessions", "verifySession", "Mark a session as verified (removed)", {
    security: "backend",
    description:
      "Removed: an operator must not assert a factor the user never presented. Always answers `403` " +
      "`not_allowed_access`; the browser reverifies with `POST /v1/client/sessions/{id}/verify/attempt_*`.",
    parameters: [idPath],
    success: { status: 403 },
    errors: [404],
  }),
  op("post", "/v1/sessions/{id}/tokens", "Sessions", "createSessionTokenBackend", "Mint a session JWT", {
    security: "backend",
    description:
      "Signs a fresh RS256 session token for an active session. Requires `X-OrbitID-Session-Token` carrying that " +
      "session's own, currently valid JWT: a secret key alone cannot mint a user's session (`403` without it). The " +
      "browser refreshes through `POST /v1/client/sessions/{id}/tokens`, authenticated by its client cookie.",
    parameters: [idPath],
    success: { status: 200, schema: ref("SessionToken") },
    errors: [400, 403, 404],
  }),
  op("post", "/v1/sessions/{id}/tokens/{template}", "Sessions", "createSessionTokenBackendForTemplate", "Mint a session JWT from a template", {
    security: "backend",
    parameters: [idPath, pathParam("template", "JWT template name.")],
    success: { status: 200, schema: ref("SessionToken") },
    errors: [400, 404],
  }),
  op("get", "/v1/clients/{id}", "Sessions", "getClientBackend", "Read a client", {
    security: "backend",
    description: "Sessions are returned without `last_active_token`: the Backend API does not mint JWTs for another client.",
    parameters: [idPath],
    ...ok(ref("Client")),
    errors: [404],
  }),
  op("post", "/v1/clients/verify", "Sessions", "verifyClientToken", "Resolve a client token", {
    security: "backend",
    description: "Looks up the client that owns an opaque client token, for server-side session checks. No session JWT is minted.",
    body: { schema: body.clientVerify },
    ...ok(ref("Client")),
    errors: [404, 422],
  }),

  // ───────────── operator session minting (removed; documented so the refusal is discoverable) ─────────────
  op("post", "/v1/sign_in_tokens", "Sign in", "createSignInToken", "Create a sign-in token (removed)", {
    security: "backend",
    description:
      "Removed: an operator credential must not be redeemable for another user's session. Always answers `403` " +
      "`not_allowed_access`. Let the user sign in, or send a password-reset or invitation email instead.",
    body: { schema: body.signInTokenCreate },
    success: { status: 403 },
  }),
  op("post", "/v1/sign_in_tokens/{id}/revoke", "Sign in", "revokeSignInToken", "Revoke a sign-in token (removed)", {
    security: "backend",
    parameters: [idPath],
    success: { status: 403 },
  }),
  op("post", "/v1/actor_tokens", "Sessions", "createActorToken", "Create an impersonation token (removed)", {
    security: "backend",
    description:
      "Removed: impersonation let an operator take over a user's account, bypassing their password, second factor and " +
      "trusted-device policy. Always answers `403` `not_allowed_access`.",
    body: { schema: body.actorTokenCreate },
    success: { status: 403 },
  }),
  op("post", "/v1/actor_tokens/{id}/revoke", "Sessions", "revokeActorToken", "Revoke an actor token (removed)", {
    security: "backend",
    parameters: [idPath],
    success: { status: 403 },
  }),

  // ───────────── invitations and waitlist ─────────────
  op("get", "/v1/invitations", "Invitations", "listInvitations", "List invitations", {
    security: "backend",
    description: "Filters: `status` (also accepted as `status[]`), `query` on the email address.",
    parameters: [...backendListParams, queryParam("status", { type: "string" }), queryParam("query", { type: "string" })],
    ...list(ref("Invitation")),
    errors: [429],
  }),
  op("get", "/v1/invitations/{id}", "Invitations", "getInvitation", "Read an invitation", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Invitation")),
    errors: [404],
  }),
  op("post", "/v1/invitations", "Invitations", "createInvitation", "Create an invitation", {
    security: "backend",
    description: "`notify=false` skips the email and returns the invitation `url` instead. The invitation allows a restricted sign-up.",
    body: { schema: body.invitationCreate },
    ...ok(ref("Invitation")),
    errors: [422],
  }),
  op("post", "/v1/invitations/bulk", "Invitations", "createInvitationsBulk", "Create invitations in bulk", {
    security: "backend",
    description: "Existing pending invitations are skipped when `ignore_existing` is true (the default for bulk).",
    body: { schema: body.invitationBulk },
    success: { status: 200, schema: arr(ref("Invitation")) },
    errors: [422],
  }),
  op("post", "/v1/invitations/{id}/revoke", "Invitations", "revokeInvitation", "Revoke an invitation", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Invitation")),
    errors: [404],
  }),
  op("get", "/v1/waitlist_entries", "Invitations", "listWaitlistEntries", "List waitlist entries", {
    security: "backend",
    description: "Filters: `status`, `query` on the email address.",
    parameters: [...backendListParams, queryParam("status", { type: "string" }), queryParam("query", { type: "string" })],
    ...list(ref("WaitlistEntry")),
    errors: [429],
  }),
  op("post", "/v1/waitlist_entries", "Invitations", "createWaitlistEntry", "Add a waitlist entry", {
    security: "backend",
    body: { schema: body.waitlistCreate },
    ...ok(ref("WaitlistEntry")),
    errors: [422],
  }),
  op("post", "/v1/waitlist_entries/{id}/invite", "Invitations", "inviteWaitlistEntry", "Invite a waitlist entry", {
    security: "backend",
    description: "Creates an invitation, sends the waitlist email and marks the entry invited.",
    parameters: [idPath],
    ...ok(ref("WaitlistEntry")),
    errors: [404, 422],
  }),
  op("post", "/v1/waitlist_entries/{id}/reject", "Invitations", "rejectWaitlistEntry", "Reject a waitlist entry", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("WaitlistEntry")),
    errors: [404],
  }),
  op("delete", "/v1/waitlist_entries/{id}", "Invitations", "deleteWaitlistEntry", "Delete a waitlist entry", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "waitlist_entry" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),
];
