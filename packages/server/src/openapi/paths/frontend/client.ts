/** frontend paths: client. */
import { arr, int, obj, opt, ref, str } from "../../schema";
import { op, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { fapiWithClient } from "../common";
import { id, tagSessions } from "./common";

export const operations: DocumentedOperation[] = [
  // ───────────── client and sessions ─────────────
  op("get", "/v1/client", tagSessions, "getClient", "Read the client", {
    security: "frontendOptional",
    description:
      "Returns the browser's client state (sessions, in-flight sign-in and sign-up). Creates a client and sets the " +
      "httpOnly `__client` cookie when the request has none, so call it once on load.",
    success: { status: 200, schema: obj({ response: ref("Client"), client: ref("Client") }) },
    errors: [429],
  }),
  op("delete", "/v1/client", tagSessions, "deleteClient", "Sign out of every session", {
    security: "frontend",
    description: "Ends all sessions of this client, clears the `__client` cookie and returns a fresh client.",
    success: { status: 200, schema: obj({ response: ref("Client"), client: ref("Client") }) },
    errors: [429],
  }),
  op("get", "/v1/client/sessions", tagSessions, "listClientSessions", "List this client's sessions", {
    security: "frontend",
    description: "Expired sessions are omitted. Active ones carry a freshly signed `last_active_token.jwt`.",
    success: { status: 200, schema: obj({ response: arr(ref("Session")) }) },
    errors: [401],
  }),
  op("post", "/v1/client/sessions/{id}/touch", tagSessions, "touchSession", "Touch a session", {
    security: "frontend",
    description: "Updates activity and optionally makes an organization active (`last_active_organization_id`).",
    parameters: [id],
    body: { schema: body.sessionTouch },
    ...fapiWithClient(ref("Session")),
    errors: [401, 403, 404, 409, 422],
  }),
  op("post", "/v1/client/sessions/{id}/end", tagSessions, "endSession", "End a session", {
    security: "frontend",
    parameters: [id],
    ...fapiWithClient(ref("Session")),
    errors: [401, 404],
  }),
  op("post", "/v1/client/sessions/{id}/remove", tagSessions, "removeSession", "Remove a session", {
    security: "frontend",
    description: "Like `end`, but records the session as removed, which is what signing out of the current device does.",
    parameters: [id],
    ...fapiWithClient(ref("Session")),
    errors: [401, 404],
  }),
  op("post", "/v1/client/sessions/{id}/tokens", tagSessions, "createSessionToken", "Mint a session JWT", {
    security: "frontend",
    description:
      "Signs a short-lived (60 s) RS256 JWT for the session, optionally with a JWT template. The browser SDK calls this " +
      "about every 50 s and writes the result to `__session`. Rate limited to 300 calls per minute per client.",
    parameters: [id],
    body: { schema: body.sessionTokenRequest, required: false },
    success: { status: 200, schema: obj({ jwt: str() }) },
    errors: [400, 401, 404, 429],
  }),
  op("post", "/v1/client/sessions/{id}/tokens/{template}", tagSessions, "createSessionTokenForTemplate", "Mint a session JWT from a template", {
    security: "frontend",
    description: "Same as `createSessionToken` with the template in the path. Unknown templates return 404.",
    parameters: [id, pathParam("template", "JWT template name.")],
    success: { status: 200, schema: obj({ jwt: str() }) },
    errors: [401, 404, 429],
  }),
  op("post", "/v1/client/sessions/{id}/verify", tagSessions, "startSessionReverification", "Start reverification", {
    security: "frontend",
    description:
      "Starts a reverification for endpoints that need a recent factor (profile changes, deleting the account, " +
      "revoking devices). Read `response.verification` for the next step. Endpoints that need reverification answer " +
      "`session_reverification_required` with `meta.levels`.",
    parameters: [id],
    body: { schema: body.sessionVerify, required: false },
    ...fapiWithClient(ref("Session")),
    errors: [400, 401, 404, 422],
  }),
  op("post", "/v1/client/sessions/{id}/verify/prepare_first_factor", tagSessions, "prepareSessionReverificationFirstFactor", "Send a reverification first factor", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.sessionVerifyFirst },
    ...fapiWithClient(ref("Verification")),
    errors: [400, 401, 404, 422, 429],
  }),
  op("post", "/v1/client/sessions/{id}/verify/attempt_first_factor", tagSessions, "attemptSessionReverificationFirstFactor", "Submit a reverification first factor", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.sessionVerifyFirstAttempt },
    ...fapiWithClient(ref("Verification")),
    errors: [400, 401, 404, 422, 429],
  }),
  op("post", "/v1/client/sessions/{id}/verify/prepare_second_factor", tagSessions, "prepareSessionReverificationSecondFactor", "Send a reverification second factor", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.sessionVerifySecond },
    ...fapiWithClient(ref("Verification")),
    errors: [400, 401, 404, 422, 429],
  }),
  op("post", "/v1/client/sessions/{id}/verify/attempt_second_factor", tagSessions, "attemptSessionReverificationSecondFactor", "Submit a reverification second factor", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.sessionVerifySecondAttempt },
    ...fapiWithClient(ref("Verification")),
    errors: [400, 401, 404, 422, 429],
  }),
  op("get", "/v1/client/sessions/{id}/verification", tagSessions, "getSessionVerification", "Read reverification ages", {
    security: "frontend",
    description:
      "Minutes since the session's first and second factor were verified (`-1` when never), which is what the SDK's " +
      "reverification hook uses to decide whether a fresh factor is needed.",
    parameters: [id],
    success: { status: 200, schema: obj({ response: obj({ first_factor: int(), second_factor: int() }, { description: "Minutes since each factor was verified; `-1` when never." }) }) },
    errors: [401, 404],
  }),

  // ───────────── public assets and landing pages ─────────────
  op("get", "/v1/client/images/{file}", "Users (frontend)", "getProfileImage", "Read an uploaded profile image", {
    security: "none",
    description: "Serves files written by profile image uploads. Only image extensions are accepted.",
    parameters: [pathParam("file", "File name `<user id>_<random>.<ext>`.")],
    success: { status: 200, contentType: "image/png", schema: str({ format: "binary" }), description: "The image bytes." },
    errors: [404],
  }),
  op("get", "/v1/client/organization_logos/{file}", "Organizations", "getOrganizationLogo", "Read an organization logo", {
    security: "none",
    description: "Serves files written by the logo upload endpoints.",
    parameters: [pathParam("file", "File name `<organization id>.<ext>`.")],
    success: { status: 200, contentType: "image/png", schema: str({ format: "binary" }), description: "The image bytes." },
    errors: [404],
  }),
  op("get", "/v1/client/organization_invitations/accept", "Invitations", "acceptOrganizationInvitation", "Accept an invitation from a link", {
    security: "none",
    description:
      "Landing page for the link sent in an organization invitation email. Redeems the `ticket`, adds the membership " +
      "when an account is signed in and redirects to the app with `__orbit_status` set.",
    parameters: [
      queryParam("ticket", { type: "string" }, "Invitation ticket from the email."),
      queryParam("redirect_url", { type: "string" }, "Where to continue after acceptance."),
    ],
    success: { status: 302, description: "Redirect to the app with `__orbit_status` set.", headers: { Location: { type: "string" } } },
    errors: [400, 404],
  }),
  op("get", "/v1/verify", "Sign in", "verifyLink", "Open a magic link", {
    security: "none",
    description:
      "Landing page for email magic links. Consumes the one-time token, advances the owning sign-in or sign-up " +
      "server-side so the originating tab can poll, then redirects with `__orbit_status=verified|expired|failed`.",
    parameters: [
      queryParam("token", { type: "string" }, "One-time token from the email."),
      queryParam("redirect_url", { type: "string" }, "Allowed redirect target."),
    ],
    success: { status: 302, description: "Redirect to the app.", headers: { Location: { type: "string" } } },
    errors: [400],
  }),
  op("get", "/v1/oauth_callback/{provider}", "Sign in", "oauthCallbackGet", "OAuth provider callback (GET)", {
    security: "none",
    description:
      "Return URL registered with the social provider. Exchanges the code, links or creates the user, sets the client " +
      "cookie and redirects back to the app. Errors are reported on the redirect as `__orbit_error`.",
    parameters: [pathParam("provider", "Provider key, for example `google`."), queryParam("code", { type: "string" }), queryParam("state", { type: "string" })],
    success: { status: 302, description: "Redirect to the app.", headers: { Location: { type: "string" } } },
    errors: [400, 404],
  }),
  op("post", "/v1/oauth_callback/{provider}", "Sign in", "oauthCallbackPost", "OAuth provider callback (POST)", {
    security: "none",
    description: "Form-post variant used by providers that return `form_post` (Apple sends the user's name this way, once).",
    parameters: [pathParam("provider", "Provider key.")],
    body: { schema: obj({ state: str(), code: opt(str()), error: opt(str()), user: opt(str()) }), contentType: "application/x-www-form-urlencoded", required: false },
    success: { status: 302, description: "Redirect to the app.", headers: { Location: { type: "string" } } },
    errors: [400, 404],
  }),

  // ───────────── waitlist ─────────────
  op("post", "/v1/client/waitlist", "Invitations", "joinWaitlist", "Join the waitlist", {
    security: "none",
    description:
      "Only available when the instance's sign-up mode is `waitlist`. Idempotent per email address. Rate limited to " +
      "5 requests per hour per IP.",
    body: { schema: body.waitlistJoin },
    success: { status: 200, schema: obj({ response: ref("WaitlistEntry") }) },
    errors: [422, 429],
  }),

  // ───────────── enterprise SSO browser flows ─────────────
  op("get", "/v1/client/enterprise/start", "Enterprise SSO", "startEnterpriseSso", "Start an enterprise SSO sign-in", {
    security: "none",
    description:
      "Redirects to the identity provider for the connection matching `connection_id`, or the identifier's domain. " +
      "Needs an in-progress sign-in from this browser; the `__client` cookie chooses it.",
    parameters: [
      queryParam("connection_id", { type: "string" }),
      queryParam("identifier", { type: "string" }),
      queryParam("domain", { type: "string" }),
      queryParam("email_address", { type: "string" }),
      queryParam("redirect_url", { type: "string" }),
      queryParam("action_complete_redirect_url", { type: "string" }),
    ],
    success: { status: 302, description: "Redirect to the identity provider.", headers: { Location: { type: "string" } } },
    errors: [400, 404, 422],
  }),
  op("get", "/v1/client/enterprise/oidc_callback/{id}", "Enterprise SSO", "enterpriseOidcCallback", "Enterprise OIDC callback", {
    security: "none",
    description: "Return URL for enterprise OIDC connections. Replaces the browser binding check may fail with 400 `verification_failed`.",
    parameters: [id, queryParam("code", { type: "string" }), queryParam("state", { type: "string" }), queryParam("error", { type: "string" })],
    success: { status: 302, description: "Redirect to the app.", headers: { Location: { type: "string" } } },
    errors: [400, 404],
  }),
];
