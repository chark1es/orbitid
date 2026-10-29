/**
 * Frontend API: client, sign in, sign up, the signed-in user, sessions, waitlist and the browser landing pages.
 * All of these authenticate with the `__client` cookie (or a client token as a bearer credential).
 */
import { arr, deletedObject, int, nullable, obj, opt, ref, str } from "../schema";
import { op, pathParam, queryParam, type DocumentedOperation } from "../operation";
import * as body from "../requests";
import { fapiWithClient } from "./common";

const id = pathParam("id", "The resource id.");
const tagSignIn = "Sign in";
const tagSignUp = "Sign up";
const tagSessions = "Sessions";
const tagMe = "Users (frontend)";

export const frontendPaths: DocumentedOperation[] = [
  // ───────────── environment ─────────────
  op("get", "/v1/client/environment", "Instance", "getEnvironment", "Read the environment settings", {
    security: "none",
    description:
      "Public projection of the instance settings that every UI component renders from: enabled factors, attribute " +
      "requirements, organization settings and branding. Cacheable for 60 seconds; contains no secrets.",
    success: { status: 200, schema: ref("Environment") },
    errors: [429],
  }),

  // ───────────── sign in ─────────────
  op("post", "/v1/client/sign_ins", tagSignIn, "createSignIn", "Start a sign-in", {
    security: "frontendOptional",
    description:
      "Creates a sign-in attempt for this client and advances it as far as the request allows. `status` says what is " +
      "needed next: `needs_identifier`, `needs_first_factor`, `needs_second_factor`, `needs_new_password` or " +
      "`complete` (with `created_session_id`). Starting an OAuth or enterprise SSO strategy returns " +
      "`first_factor_verification.external_verification_redirect_url`; navigate the browser there. " +
      "Failed password attempts count towards the user's lockout, and unknown identifiers return " +
      "`form_identifier_not_found` unless enumeration protection is on. Rate limited per IP and identifier.",
    body: { schema: body.signInCreate },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("get", "/v1/client/sign_ins/{id}", tagSignIn, "getSignIn", "Read a sign-in attempt", {
    security: "frontendOptional",
    description: "Lets a second tab or a polling page observe progress (for example after an email link was opened elsewhere).",
    parameters: [id],
    ...fapiWithClient(ref("SignIn")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/sign_ins/{id}/prepare_first_factor", tagSignIn, "prepareSignInFirstFactor", "Send a first-factor challenge", {
    security: "frontendOptional",
    description:
      "Sends the email code, magic link or SMS code for the chosen strategy, or arms an OAuth redirect. The response " +
      "carries the updated sign-in, so read `first_factor_verification` for the strategy state.",
    parameters: [id],
    body: { schema: body.signInPrepareFirst },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 409, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/attempt_first_factor", tagSignIn, "attemptSignInFirstFactor", "Submit a first factor", {
    security: "frontendOptional",
    description:
      "Verifies the password, code, passkey assertion or OAuth callback. Wrong codes and passwords return " +
      "`form_code_incorrect` / `form_password_incorrect` and count towards the lockout. Rate limited.",
    parameters: [id],
    body: { schema: body.signInAttemptFirst },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/prepare_second_factor", tagSignIn, "prepareSignInSecondFactor", "Send a second-factor challenge", {
    security: "frontendOptional",
    description: "Sends an SMS code when the strategy is `phone_code`; `totp` and `backup_code` need no preparation.",
    parameters: [id],
    body: { schema: body.signInPrepareSecond },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/attempt_second_factor", tagSignIn, "attemptSignInSecondFactor", "Submit a second factor", {
    security: "frontendOptional",
    description: "Verifies a TOTP code, SMS code or single-use backup code. A completed sign-in returns `created_session_id`.",
    parameters: [id],
    body: { schema: body.signInAttemptSecond },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ins/{id}/reset_password", tagSignIn, "resetSignInPassword", "Set a new password during sign-in", {
    security: "frontendOptional",
    description:
      "Completes the `needs_new_password` state, which is entered after a password-reset code was verified. The password " +
      "policy is enforced. `sign_out_of_other_sessions` ends the user's other active sessions.",
    parameters: [id],
    body: { schema: body.signInResetPassword },
    ...fapiWithClient(ref("SignIn")),
    errors: [400, 403, 404, 422, 429],
  }),

  // ───────────── sign up ─────────────
  op("post", "/v1/client/sign_ups", tagSignUp, "createSignUp", "Start a sign-up", {
    security: "frontendOptional",
    description:
      "Creates an account attempt. The response's `missing_fields` and `unverified_fields` are computed from the " +
      "instance's attribute settings; fill them in with `PATCH` and verify identifiers with " +
      "`prepare_verification`/`attempt_verification`. Sign-up completes (`status: complete`, `created_session_id` set) " +
      "as soon as nothing is missing. Sign-up is gated by the instance's sign-up mode, the allow/block lists and " +
      "invitation tickets. Rate limited per IP.",
    body: { schema: body.signUpCreate },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 409, 422, 429],
  }),
  op("get", "/v1/client/sign_ups/{id}", tagSignUp, "getSignUp", "Read a sign-up attempt", {
    security: "frontendOptional",
    description: "Poll this after a magic link was opened in another tab.",
    parameters: [id],
    ...fapiWithClient(ref("SignUp")),
    errors: [403, 404],
  }),
  op("patch", "/v1/client/sign_ups/{id}", tagSignUp, "updateSignUp", "Add fields to a sign-up", {
    security: "frontendOptional",
    description: "Only a sign-up in `missing_requirements` can be updated. Changing an identifier invalidates its outstanding verification.",
    parameters: [id],
    body: { schema: body.signUpUpdate },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 404, 409, 422, 429],
  }),
  op("post", "/v1/client/sign_ups/{id}/prepare_verification", tagSignUp, "prepareSignUpVerification", "Send an identifier verification", {
    security: "frontendOptional",
    description: "Sends a code or magic link for `email_address` or `phone_number` (`strategy`: `email_code`, `email_link`, `phone_code`).",
    parameters: [id],
    body: { schema: body.verificationPrepare },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/sign_ups/{id}/attempt_verification", tagSignUp, "attemptSignUpVerification", "Submit an identifier verification", {
    security: "frontendOptional",
    description: "Verifies the code. When nothing else is missing or unverified the sign-up completes and a session is created.",
    parameters: [id],
    body: { schema: body.verificationAttempt },
    ...fapiWithClient(ref("SignUp")),
    errors: [400, 403, 404, 422, 429],
  }),

  // ───────────── the signed-in user ─────────────
  op("get", "/v1/client/me", tagMe, "getMe", "Read the signed-in user", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: ref("User") }) },
    errors: [403, 404],
  }),
  op("patch", "/v1/client/me", tagMe, "updateMe", "Update the signed-in user", {
    security: "frontend",
    description: "Updates the profile, metadata and the primary email address or phone number. `username` must be unique.",
    body: { schema: body.meUpdate },
    success: { status: 200, schema: obj({ response: ref("User") }) },
    errors: [403, 404, 409, 422, 429],
  }),
  op("delete", "/v1/client/me", tagMe, "deleteMe", "Delete the signed-in user's account", {
    security: "frontend",
    description: "Irreversible. Requires a recent first-factor verification (`session_reverification_required` otherwise), and the instance must allow self-deletion.",
    success: { status: 200, schema: deletedObject("resource") },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/profile_image", tagMe, "setMyProfileImage", "Upload a profile image", {
    security: "frontend",
    description: "Send `multipart/form-data` with a `file` field, or JSON with a base64 `file` (a `data:` URL works). PNG, JPEG, GIF and WebP up to 5 MB; the magic bytes are checked.",
    body: { schema: body.imageUpload, contentType: "multipart/form-data" },
    success: { status: 200, schema: obj({ response: ref("User") }) },
    errors: [403, 404, 422, 429],
  }),
  op("delete", "/v1/client/me/profile_image", tagMe, "deleteMyProfileImage", "Remove the profile image", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: ref("User") }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/change_password", tagMe, "changeMyPassword", "Change the password", {
    security: "frontend",
    description: "Needs the current password and a recent first-factor verification. The new password must satisfy the instance policy.",
    body: { schema: body.passwordChange },
    success: { status: 200, schema: obj({ response: ref("User") }) },
    errors: [403, 404, 422, 429],
  }),
  op("post", "/v1/client/me/remove_password", tagMe, "removeMyPassword", "Remove the password", {
    security: "frontend",
    description: "Refused with `last_identification_cannot_be_removed` when the password is the account's only way to sign in.",
    body: { schema: body.passwordRemove },
    success: { status: 200, schema: obj({ response: ref("User") }) },
    errors: [403, 404, 422, 429],
  }),

  // email addresses
  op("get", "/v1/client/me/email_addresses", tagMe, "listMyEmailAddresses", "List email addresses", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: arr(ref("EmailAddress")) }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/email_addresses", tagMe, "createMyEmailAddress", "Add an email address", {
    security: "frontend",
    description: "The address starts unverified until `attempt_verification` succeeds. Requires a recent first-factor verification.",
    body: { schema: body.emailCreate },
    success: { status: 200, schema: obj({ response: ref("EmailAddress") }) },
    errors: [403, 404, 409, 422, 429],
  }),
  op("get", "/v1/client/me/email_addresses/{id}", tagMe, "getMyEmailAddress", "Read an email address", {
    security: "frontend",
    parameters: [id],
    success: { status: 200, schema: obj({ response: ref("EmailAddress") }) },
    errors: [403, 404],
  }),
  op("delete", "/v1/client/me/email_addresses/{id}", tagMe, "deleteMyEmailAddress", "Delete an email address", {
    security: "frontend",
    description: "The primary address cannot be removed, and neither can the last identification on the account.",
    parameters: [id],
    success: { status: 200, schema: deletedObject("resource") },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/email_addresses/{id}/prepare_verification", tagMe, "prepareMyEmailVerification", "Send a verification code", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.verificationPrepare },
    success: { status: 200, schema: obj({ response: ref("EmailAddress") }) },
    errors: [403, 404, 422, 429],
  }),
  op("post", "/v1/client/me/email_addresses/{id}/attempt_verification", tagMe, "attemptMyEmailVerification", "Verify an email address", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.codeVerification },
    success: { status: 200, schema: obj({ response: ref("EmailAddress") }) },
    errors: [403, 404, 422, 429],
  }),

  // phone numbers
  op("get", "/v1/client/me/phone_numbers", tagMe, "listMyPhoneNumbers", "List phone numbers", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: arr(ref("PhoneNumber")) }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/phone_numbers", tagMe, "createMyPhoneNumber", "Add a phone number", {
    security: "frontend",
    body: { schema: body.phoneCreate },
    success: { status: 200, schema: obj({ response: ref("PhoneNumber") }) },
    errors: [403, 404, 409, 422, 429],
  }),
  op("get", "/v1/client/me/phone_numbers/{id}", tagMe, "getMyPhoneNumber", "Read a phone number", {
    security: "frontend",
    parameters: [id],
    success: { status: 200, schema: obj({ response: ref("PhoneNumber") }) },
    errors: [403, 404],
  }),
  op("patch", "/v1/client/me/phone_numbers/{id}", tagMe, "updateMyPhoneNumber", "Update a phone number", {
    security: "frontend",
    description: "Marks the number as usable for the second factor and/or as the default second factor.",
    parameters: [id],
    body: { schema: body.phoneUpdate },
    success: { status: 200, schema: obj({ response: ref("PhoneNumber") }) },
    errors: [403, 404, 409, 422],
  }),
  op("delete", "/v1/client/me/phone_numbers/{id}", tagMe, "deleteMyPhoneNumber", "Delete a phone number", {
    security: "frontend",
    parameters: [id],
    success: { status: 200, schema: deletedObject("resource") },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/phone_numbers/{id}/prepare_verification", tagMe, "prepareMyPhoneVerification", "Send an SMS code", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.verificationPrepare },
    success: { status: 200, schema: obj({ response: ref("PhoneNumber") }) },
    errors: [403, 404, 422, 429],
  }),
  op("post", "/v1/client/me/phone_numbers/{id}/attempt_verification", tagMe, "attemptMyPhoneVerification", "Verify a phone number", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.codeVerification },
    success: { status: 200, schema: obj({ response: ref("PhoneNumber") }) },
    errors: [403, 404, 422, 429],
  }),

  // external accounts
  op("get", "/v1/client/me/external_accounts", tagMe, "listMyExternalAccounts", "List connected accounts", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: arr(ref("ExternalAccount")) }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/external_accounts", tagMe, "createMyExternalAccount", "Connect a social account", {
    security: "frontend",
    description:
      "Starts an OAuth flow. The response contains a placeholder external account whose " +
      "`verification.external_verification_redirect_url` is where the browser must go; the return path is " +
      "`redirect_url`. Requires a recent first-factor verification.",
    body: { schema: body.externalAccountCreate },
    success: { status: 200, schema: obj({ response: ref("ExternalAccount") }) },
    errors: [400, 403, 404, 422, 429],
  }),
  op("delete", "/v1/client/me/external_accounts/{id}", tagMe, "deleteMyExternalAccount", "Disconnect a social account", {
    security: "frontend",
    description: "Refused when it is the account's last identification.",
    parameters: [id],
    success: { status: 200, schema: deletedObject("resource") },
    errors: [403, 404],
  }),
  op("get", "/v1/client/me/external_accounts/{id}/access_token", tagMe, "getMyExternalAccountToken", "Read the provider access token", {
    security: "frontend",
    description: "Returns the stored provider token and its scopes. Requires a recent first-factor verification.",
    parameters: [id],
    success: { status: 200, schema: obj({ response: ref("ExternalAccountAccessToken") }) },
    errors: [403, 404],
  }),

  // TOTP and backup codes
  op("get", "/v1/client/me/totp", tagMe, "getMyTotp", "Read the authenticator app state", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: ref("Totp") }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/totp", tagMe, "createMyTotp", "Start authenticator app setup", {
    security: "frontend",
    description: "Returns the base32 secret, the `otpauth://` URI and a QR code data URL **once**. Confirm with `attempt_verification`.",
    success: { status: 200, schema: obj({ response: ref("Totp") }) },
    errors: [400, 403, 404, 429],
  }),
  op("post", "/v1/client/me/totp/attempt_verification", tagMe, "verifyMyTotp", "Confirm authenticator app setup", {
    security: "frontend",
    description: "On success the response includes freshly generated backup codes, shown once. Rate limited to 20 attempts per minute.",
    body: { schema: body.totpAttempt },
    success: { status: 200, schema: obj({ response: ref("Totp") }) },
    errors: [400, 403, 404, 422, 429],
  }),
  op("delete", "/v1/client/me/totp", tagMe, "deleteMyTotp", "Disable the authenticator app", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: ref("Totp") }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/backup_codes", tagMe, "regenerateMyBackupCodes", "Regenerate backup codes", {
    security: "frontend",
    description: "Replaces all existing backup codes. The plaintext codes are returned once; only their hashes are stored.",
    success: { status: 200, schema: obj({ response: arr(ref("BackupCode")) }) },
    errors: [400, 403, 404, 429],
  }),

  // trusted devices
  op("get", "/v1/client/me/trusted_devices", tagMe, "listMyTrustedDevices", "List trusted devices", {
    security: "frontend",
    description: "Browsers that may skip the second factor. Only the caller's own, unexpired and unrevoked devices are listed; the token itself is never returned.",
    success: { status: 200, schema: obj({ response: arr(ref("TrustedDevice")) }) },
    errors: [403],
  }),
  op("delete", "/v1/client/me/trusted_devices/{id}", tagMe, "revokeMyTrustedDevice", "Revoke a trusted device", {
    security: "frontend",
    description: "The browser must complete its second factor again. A device that belongs to someone else answers 404.",
    parameters: [pathParam("id", "Trusted device id (`tdev_…`).")],
    success: { status: 200, schema: obj({ response: ref("TrustedDevice") }) },
    errors: [403],
  }),
  op("get", "/v1/client/handshake", "Sessions", "handshake", "Refresh a session token during a page navigation", {
    security: "none",
    description:
      "Used by the Next.js middleware. When a hard navigation arrives with an expired `__session` cookie but a live `__client` cookie, " +
      "the app redirects the browser here with `redirect_url`. The server answers `302` to `redirect_url` with `__orbit_handshake=<session token>`, " +
      "or `__orbit_handshake=signed_out` when there is no active session. `redirect_url` must be an allowed origin. The response is not cacheable " +
      "and sends no referrer. See docs/HANDSHAKE.md.",
    parameters: [queryParam("redirect_url", str({ description: "Absolute http(s) URL to return to." }), "Where to send the browser next.")],
    success: { status: 302, description: "Redirect back to the app.", headers: { Location: { type: "string", description: "`redirect_url` with the `__orbit_handshake` parameter." } } },
    errors: [429],
  }),
  op("get", "/v1/client/oauth/device", tagMe, "getDeviceAuthorization", "Look up a device code", {
    security: "frontend",
    description: "Shows the application and scopes behind a user code, so the signed-in user can confirm before approving. Only available when device authorization is enabled. Each lookup counts against a small per-code and per-address attempt budget.",
    parameters: [queryParam("user_code", str({ description: "The code shown on the device, for example `ABCD-EFGH`." }), "The user code.")],
    success: {
      status: 200,
      schema: obj({
        user_code: str(),
        status: { type: "string", enum: ["pending", "approved", "denied", "consumed"] },
        expires_at: int(),
        client: obj({ id: str(), client_id: str(), name: str(), public: { type: "boolean" } }),
        scopes: arr(obj({ scope: str(), description: str() })),
      }),
    },
    errors: [403, 404, 410, 422, 429],
  }),
  op("post", "/v1/client/oauth/device/approve", tagMe, "decideDeviceAuthorization", "Approve or deny a device code", {
    security: "frontend",
    description: "The signed-in user approves or denies the device that showed `user_code`. A code that expired answers 410; one already decided answers 409.",
    body: { schema: obj({ user_code: str(), action: { type: "string", enum: ["approve", "deny"] } }) },
    success: {
      status: 200,
      schema: obj({
        object: { const: "oauth_device_authorization" },
        user_code: str(),
        status: { type: "string", enum: ["approved", "denied"] },
        client: obj({ id: str(), client_id: str(), name: str() }),
        scopes: arr(str()),
      }),
    },
    errors: [403, 404, 409, 410, 422, 429],
  }),

  // passkeys
  op("get", "/v1/client/me/passkeys", tagMe, "listMyPasskeys", "List passkeys", {
    security: "frontend",
    success: { status: 200, schema: obj({ response: arr(ref("Passkey")) }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/passkeys", tagMe, "createMyPasskey", "Start passkey registration", {
    security: "frontend",
    description: "Returns WebAuthn creation options; finish with `attempt_verification`, sending the credential.",
    body: { schema: body.passkeyCreate },
    success: { status: 200, schema: obj({ response: ref("Passkey") }, { additional: true }) },
    errors: [400, 403, 404, 422, 429],
  }),
  op("post", "/v1/client/me/passkeys/{id}/attempt_verification", tagMe, "verifyMyPasskey", "Finish passkey registration", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.passkeyAttempt },
    success: { status: 200, schema: obj({ response: ref("Passkey") }) },
    errors: [400, 403, 404, 422, 429],
  }),
  op("patch", "/v1/client/me/passkeys/{id}", tagMe, "renameMyPasskey", "Rename a passkey", {
    security: "frontend",
    parameters: [id],
    body: { schema: body.passkeyRename },
    success: { status: 200, schema: obj({ response: ref("Passkey") }) },
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/client/me/passkeys/{id}", tagMe, "deleteMyPasskey", "Delete a passkey", {
    security: "frontend",
    parameters: [id],
    success: { status: 200, schema: deletedObject("resource") },
    errors: [403, 404],
  }),

  // devices
  op("get", "/v1/client/me/sessions/active", tagMe, "listMyActiveSessions", "List the sessions of this account", {
    security: "frontend",
    description: "Every live session of the user, across devices, for the account's active-devices list.",
    success: { status: 200, schema: obj({ response: arr(ref("Session")) }) },
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/sessions/{id}/revoke", tagMe, "revokeMySession", "Sign out another device", {
    security: "frontend",
    description: "Requires a recent first-factor verification.",
    parameters: [id],
    success: { status: 200, schema: obj({ response: ref("Session") }) },
    errors: [403, 404, 429],
  }),

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
