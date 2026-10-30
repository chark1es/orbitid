/** frontend paths: me. */
import { arr, deletedObject, int, obj, ref, str } from "../../schema";
import { op, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { list } from "../common";
import { id, tagMe } from "./common";

export const operations: DocumentedOperation[] = [
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
];
