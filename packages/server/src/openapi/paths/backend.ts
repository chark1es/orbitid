/** Backend API: users, identifiers, sessions, clients, tokens, JWT templates, instance, invitations, waitlist. */
import { arr, obj, ref, str } from "../schema";
import { backendListParams, idPath, op, pathParam, queryParam, type DocumentedOperation } from "../operation";
import * as body from "../requests";
import { list, ok } from "./common";

const userId = pathParam("id", "User id (`user_…`).");

/** Array filter parameters the user list accepts; repeated, comma separated and single values all work. */
const multi = (name: string, description: string) => ({ name, in: "query" as const, description, schema: { type: "array", items: { type: "string" } } });

export const backendPaths: DocumentedOperation[] = [
  // ───────────── users ─────────────
  op("get", "/v1/users", "Users (backend)", "listUsers", "List users", {
    security: "backend",
    description:
      "Filters combine with AND. Array filters (`email_address`, `phone_number`, `username`, `external_id`, `user_id`, " +
      "`organization_id`) may be repeated, comma separated or single and are intersected. Without " +
      "`?paginated=true` the body is a bare array and `x-total-count` carries the total.",
    parameters: [
      ...backendListParams,
      queryParam("query", { type: "string" }, "Free-text match on id, username, name, email address or phone number."),
      multi("email_address", "Only users with one of these email addresses."),
      multi("phone_number", "Only users with one of these phone numbers."),
      multi("username", "Only users with one of these usernames."),
      multi("external_id", "Only users with one of these external ids."),
      multi("user_id", "Only these user ids."),
      multi("organization_id", "Only members of these organizations."),
      queryParam("banned", { type: "boolean" }),
      queryParam("locked", { type: "boolean" }),
      queryParam("mfa", { type: "boolean" }, "Only users with (or without) an authenticator app."),
      queryParam("last_active_at_since", { type: "integer" }, "Epoch milliseconds."),
      queryParam("created_at_after", { type: "integer" }, "Epoch milliseconds, inclusive."),
      queryParam("created_at_before", { type: "integer" }, "Epoch milliseconds, exclusive."),
      queryParam("paginated", { type: "string", enum: ["true"] }, "Return `{ data, total_count }` instead of a bare array."),
    ],
    success: {
      status: 200,
      schema: { anyOf: [arr(ref("User")), obj({ data: arr(ref("User")), total_count: { type: "integer" } })] },
      headers: { "x-total-count": { type: "string" } },
      description: "A bare array, or `{ data, total_count }` with `?paginated=true`.",
    },
    errors: [429],
  }),
  op("get", "/v1/users/count", "Users (backend)", "countUsers", "Count users", {
    security: "backend",
    description: "Accepts the same filters as `listUsers`.",
    parameters: [queryParam("query", { type: "string" }), queryParam("banned", { type: "boolean" }), queryParam("locked", { type: "boolean" }), queryParam("mfa", { type: "boolean" })],
    success: { status: 200, schema: ref("TotalCount") },
    errors: [429],
  }),
  op("post", "/v1/users", "Users (backend)", "createUser", "Create a user", {
    security: "backend",
    description:
      "Creates a user with verified identifiers. Send `password` or a `password_digest` with `password_hasher` (not both). " +
      "`public_metadata` is visible to the browser, `private_metadata` stays server-side, `unsafe_metadata` is writable by the user. " +
      "A `user.created` webhook fires after the row is written.",
    body: { schema: body.userCreate },
    ...ok(ref("User")),
    errors: [409, 422],
  }),
  op("get", "/v1/users/{id}", "Users (backend)", "getUser", "Read a user", {
    security: "backend",
    description: "Includes `private_metadata`; the Frontend API never returns it.",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("patch", "/v1/users/{id}", "Users (backend)", "updateUser", "Update a user", {
    security: "backend",
    description:
      "Updates profile fields, metadata, MFA secrets and limits. Changing the password can end the user's other sessions " +
      "(`sign_out_of_other_sessions`). Emits `user.updated`.",
    parameters: [userId],
    body: { schema: body.userUpdate },
    ...ok(ref("User")),
    errors: [404, 409, 422],
  }),
  op("patch", "/v1/users/{id}/metadata", "Users (backend)", "updateUserMetadata", "Merge user metadata", {
    security: "backend",
    description: "Deep-merges each metadata object; a `null` value deletes the key. Emits `user.updated`.",
    parameters: [userId],
    body: { schema: body.metadataPatch },
    ...ok(ref("User")),
    errors: [404, 422],
  }),
  op("delete", "/v1/users/{id}", "Users (backend)", "deleteUser", "Delete a user", {
    security: "backend",
    description: "Deletes the user with all identifiers, sessions, memberships and tokens. Emits `user.deleted`.",
    parameters: [userId],
    success: { status: 200, schema: obj({ object: { const: "user" }, id: str(), deleted: { const: true } }) },
    errors: [404],
  }),
  op("post", "/v1/users/{id}/ban", "Users (backend)", "banUser", "Ban a user", {
    security: "backend",
    description: "Ends the user's active sessions and refuses future sign-ins with `user_banned`.",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("post", "/v1/users/{id}/unban", "Users (backend)", "unbanUser", "Unban a user", {
    security: "backend",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("post", "/v1/users/{id}/lock", "Users (backend)", "lockUser", "Lock a user", {
    security: "backend",
    description: "Temporary lock with a fixed duration; the user cannot sign in until it expires.",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("post", "/v1/users/{id}/unlock", "Users (backend)", "unlockUser", "Unlock a user", {
    security: "backend",
    description: "Clears the lock and the failed-attempt counter.",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("post", "/v1/users/{id}/verify_password", "Users (backend)", "verifyUserPassword", "Check a user's password", {
    security: "backend",
    description: "Answers `{ object, id, verified }`; it never returns the hash. Rate limited.",
    parameters: [userId],
    body: { schema: body.passwordCheck },
    success: { status: 200, schema: obj({ object: { const: "user" }, id: str(), verified: { type: "boolean" } }) },
    errors: [404, 422, 429],
  }),
  op("post", "/v1/users/{id}/verify_totp", "Users (backend)", "verifyUserTotp", "Check a user's TOTP code", {
    security: "backend",
    parameters: [userId],
    body: { schema: body.totpCheck },
    success: { status: 200, schema: obj({ object: { const: "user" }, id: str(), verified: { type: "boolean" } }) },
    errors: [404, 422, 429],
  }),
  op("delete", "/v1/users/{id}/mfa", "Users (backend)", "resetUserMfa", "Reset a user's MFA", {
    security: "backend",
    description: "Disables the authenticator app and deletes backup codes, so the user can enrol again.",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("delete", "/v1/users/{id}/password", "Users (backend)", "removeUserPassword", "Remove a user's password", {
    security: "backend",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("post", "/v1/users/{id}/profile_image", "Users (backend)", "setUserProfileImage", "Set a user's profile image", {
    security: "backend",
    description: "`multipart/form-data` with a `file` field, or JSON with a base64 `file`.",
    parameters: [userId],
    body: { schema: body.imageUpload, contentType: "multipart/form-data" },
    ...ok(ref("User")),
    errors: [404, 422],
  }),
  op("delete", "/v1/users/{id}/profile_image", "Users (backend)", "deleteUserProfileImage", "Remove a user's profile image", {
    security: "backend",
    parameters: [userId],
    ...ok(ref("User")),
    errors: [404],
  }),
  op("get", "/v1/users/{id}/oauth_access_tokens/{provider}", "Users (backend)", "getUserOAuthTokens", "Read a user's provider tokens", {
    security: "backend",
    description: "Returns the stored access token, scopes and expiry for each external account of that provider.",
    parameters: [userId, pathParam("provider", "Provider key, for example `google`.")],
    success: {
      status: 200,
      schema: arr(obj({
        object: { const: "oauth_access_token" },
        external_account_id: str(),
        provider: str(),
        token: { type: ["string", "null"] },
        scopes: str(),
        expires_at: { type: ["integer", "null"] },
      })),
    },
    errors: [404],
  }),
  op("get", "/v1/users/{id}/organization_memberships", "Users (backend)", "listUserOrganizationMemberships", "List a user's memberships", {
    security: "backend",
    parameters: [userId, ...backendListParams],
    ...list(ref("OrganizationMembership")),
    errors: [404],
  }),

  // ───────────── identifiers ─────────────
  op("get", "/v1/email_addresses", "Users (backend)", "listEmailAddresses", "List email addresses", {
    security: "backend",
    description: "Filter by `user_id` and `email_address`.",
    parameters: [...backendListParams, queryParam("user_id", { type: "string" }), queryParam("email_address", { type: "string" })],
    ...list(ref("EmailAddress")),
    errors: [429],
  }),
  op("get", "/v1/email_addresses/{id}", "Users (backend)", "getEmailAddress", "Read an email address", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("EmailAddress")),
    errors: [404],
  }),
  op("post", "/v1/email_addresses", "Users (backend)", "createEmailAddress", "Add an email address to a user", {
    security: "backend",
    description: "`verified` and `primary` default to `true`; a duplicate address returns 409.",
    body: { schema: body.emailAddressCreate },
    ...ok(ref("EmailAddress")),
    errors: [404, 422],
  }),
  op("patch", "/v1/email_addresses/{id}", "Users (backend)", "updateEmailAddress", "Update an email address", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.identifierUpdate },
    ...ok(ref("EmailAddress")),
    errors: [404, 422],
  }),
  op("delete", "/v1/email_addresses/{id}", "Users (backend)", "deleteEmailAddress", "Delete an email address", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "email_address" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),
  op("get", "/v1/phone_numbers", "Users (backend)", "listPhoneNumbers", "List phone numbers", {
    security: "backend",
    parameters: [...backendListParams, queryParam("user_id", { type: "string" }), queryParam("phone_number", { type: "string" })],
    ...list(ref("PhoneNumber")),
    errors: [429],
  }),
  op("get", "/v1/phone_numbers/{id}", "Users (backend)", "getPhoneNumber", "Read a phone number", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("PhoneNumber")),
    errors: [404],
  }),
  op("post", "/v1/phone_numbers", "Users (backend)", "createPhoneNumber", "Add a phone number to a user", {
    security: "backend",
    body: { schema: body.phoneNumberCreate },
    ...ok(ref("PhoneNumber")),
    errors: [404, 422],
  }),
  op("patch", "/v1/phone_numbers/{id}", "Users (backend)", "updatePhoneNumber", "Update a phone number", {
    security: "backend",
    description: "`default_second_factor: true` also marks the number as reserved for the second factor and clears the flag on the user's other numbers.",
    parameters: [idPath],
    body: { schema: body.phoneNumberUpdate },
    ...ok(ref("PhoneNumber")),
    errors: [404, 422],
  }),
  op("delete", "/v1/phone_numbers/{id}", "Users (backend)", "deletePhoneNumber", "Delete a phone number", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "phone_number" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),
  op("get", "/v1/allowlist_identifiers", "Users (backend)", "listAllowlistIdentifiers", "List allowlist entries", {
    security: "backend",
    parameters: backendListParams,
    ...list(ref("AllowlistIdentifier")),
    errors: [429],
  }),
  op("post", "/v1/allowlist_identifiers", "Users (backend)", "createAllowlistIdentifier", "Allow an identifier", {
    security: "backend",
    description: "`notify` sends a sign-up invitation to the address. Entries bypass the restricted sign-up mode.",
    body: { schema: body.allowlistCreate },
    ...ok(ref("AllowlistIdentifier")),
    errors: [422],
  }),
  op("delete", "/v1/allowlist_identifiers/{id}", "Users (backend)", "deleteAllowlistIdentifier", "Remove an allowlist entry", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "allowlist_identifier" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),
  op("get", "/v1/blocklist_identifiers", "Users (backend)", "listBlocklistIdentifiers", "List blocklist entries", {
    security: "backend",
    parameters: backendListParams,
    ...list(ref("BlocklistIdentifier")),
    errors: [429],
  }),
  op("post", "/v1/blocklist_identifiers", "Users (backend)", "createBlocklistIdentifier", "Block an identifier", {
    security: "backend",
    description: "A blocked identifier cannot sign up or sign in (`identifier_not_allowed`).",
    body: { schema: body.blocklistCreate },
    ...ok(ref("BlocklistIdentifier")),
    errors: [422],
  }),
  op("delete", "/v1/blocklist_identifiers/{id}", "Users (backend)", "deleteBlocklistIdentifier", "Remove a blocklist entry", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "blocklist_identifier" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),

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
  op("post", "/v1/sessions/{id}/verify", "Sessions", "verifySession", "Mark a session as verified", {
    security: "backend",
    description: "Records a fresh first factor (and second factor when the user has MFA) without a browser round trip.",
    parameters: [idPath],
    ...ok(ref("Session")),
    errors: [404],
  }),
  op("post", "/v1/sessions/{id}/tokens", "Sessions", "createSessionTokenBackend", "Mint a session JWT", {
    security: "backend",
    description: "Signs a fresh RS256 session token for an active session.",
    parameters: [idPath],
    success: { status: 200, schema: ref("SessionToken") },
    errors: [400, 404],
  }),
  op("post", "/v1/sessions/{id}/tokens/{template}", "Sessions", "createSessionTokenBackendForTemplate", "Mint a session JWT from a template", {
    security: "backend",
    parameters: [idPath, pathParam("template", "JWT template name.")],
    success: { status: 200, schema: ref("SessionToken") },
    errors: [400, 404],
  }),
  op("get", "/v1/clients/{id}", "Sessions", "getClientBackend", "Read a client", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Client")),
    errors: [404],
  }),
  op("post", "/v1/clients/verify", "Sessions", "verifyClientToken", "Resolve a client token", {
    security: "backend",
    description: "Looks up the client that owns an opaque client token, for server-side session checks.",
    body: { schema: body.clientVerify },
    ...ok(ref("Client")),
    errors: [404, 422],
  }),

  // ───────────── sign-in and actor tokens ─────────────
  op("post", "/v1/sign_in_tokens", "Sign in", "createSignInToken", "Create a sign-in token", {
    security: "backend",
    description:
      "One-time link that signs a user in without a password. The `token` and the ready-made `url` are returned once; " +
      "they expire after the given lifetime. Redeem it through `POST /v1/client/sign_ins` with `strategy: \"ticket\"`.",
    body: { schema: body.signInTokenCreate },
    ...ok(ref("SignInToken")),
    errors: [404, 422, 429],
  }),
  op("post", "/v1/sign_in_tokens/{id}/revoke", "Sign in", "revokeSignInToken", "Revoke a sign-in token", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("SignInToken")),
    errors: [404],
  }),
  op("post", "/v1/actor_tokens", "Sessions", "createActorToken", "Create an impersonation token", {
    security: "backend",
    description:
      "Creates a token that signs a session in as another actor. Redeem it with `POST /v1/client/sign_ins` " +
      "(`strategy: \"ticket\"`); the resulting session carries the `act` claim and is marked as impersonated.",
    body: { schema: body.actorTokenCreate },
    ...ok(ref("ActorToken")),
    errors: [404, 422, 429],
  }),
  op("post", "/v1/actor_tokens/{id}/revoke", "Sessions", "revokeActorToken", "Revoke an actor token", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("ActorToken")),
    errors: [404],
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

  // ───────────── JWT templates ─────────────
  op("get", "/v1/jwt_templates", "Sessions", "listJwtTemplates", "List JWT templates", {
    security: "backend",
    parameters: backendListParams,
    ...list(ref("JwtTemplate")),
    errors: [429],
  }),
  op("get", "/v1/jwt_templates/{id}", "Sessions", "getJwtTemplate", "Read a JWT template", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("JwtTemplate")),
    errors: [404],
  }),
  op("post", "/v1/jwt_templates", "Sessions", "createJwtTemplate", "Create a JWT template", {
    security: "backend",
    description:
      "Template names may contain letters, digits, `-` and `_`. Session claims (`iss`, `sub`, `exp`, `org_*`, …) are " +
      "reserved and rejected. `custom_signing_key` generates a key pair (RS256/ES256) or HMAC secret (HS256); the " +
      "verification key is returned in `signing_key`.",
    body: { schema: body.jwtTemplateCreate },
    ...ok(ref("JwtTemplate")),
    errors: [422],
  }),
  op("patch", "/v1/jwt_templates/{id}", "Sessions", "updateJwtTemplate", "Update a JWT template", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.jwtTemplateCreate },
    ...ok(ref("JwtTemplate")),
    errors: [404, 422],
  }),
  op("delete", "/v1/jwt_templates/{id}", "Sessions", "deleteJwtTemplate", "Delete a JWT template", {
    security: "backend",
    parameters: [idPath],
    ...ok({ type: "object", properties: { object: { const: "jwt_template" }, id: { type: "string" }, deleted: { const: true } } }),
    errors: [404],
  }),

  // ───────────── instance ─────────────
  op("get", "/v1/instance", "Instance", "getInstance", "Read instance settings", {
    security: "backend",
    description: "The full settings tree with secrets masked as `••••` and a sibling `<field>Set` boolean.",
    ...ok(ref("Instance")),
    errors: [429],
  }),
  op("patch", "/v1/instance", "Instance", "updateInstance", "Update instance settings", {
    security: "backend",
    description:
      "Deep-merges a partial settings tree and validates it against the settings schema. Omit masked secrets to keep " +
      "them; `null` deletes a key. Application URLs must be absolute http(s) URLs.",
    body: { schema: body.instancePatch },
    ...ok(ref("Instance")),
    errors: [422],
  }),
  op("post", "/v1/instance/test_email", "Instance", "sendTestEmail", "Send a test email", {
    security: "backend",
    description: "Sends a test message through the configured mail transport to check the settings.",
    body: { schema: body.testEmail },
    success: { status: 200, schema: obj({ status: { const: "ok" }, to: str() }) },
    errors: [422],
  }),
  op("post", "/v1/instance/signing_keys/rotate", "Instance", "rotateSigningKey", "Rotate the session signing key", {
    security: "backend",
    description:
      "Creates a new active signing key. Old keys stay in the JWKS until their tokens expire, so offline verifiers " +
      "keep working across the rotation.",
    success: { status: 200, schema: ref("SigningKey") },
    errors: [],
  }),
  op("post", "/v1/testing_tokens", "Instance", "createTestingToken", "Create a testing token", {
    security: "backend",
    description:
      "Only when testing tokens are enabled. Testing tokens bypass bot protection in test suites; they expire after " +
      "one hour. Never use them in production.",
    success: { status: 200, schema: ref("TestingToken") },
    errors: [403],
  }),
  op("get", "/v1/audit_logs", "Instance", "listAuditLogs", "List audit logs", {
    security: "backend",
    description: "Newest first. Filters: `actor`, `action`, `target_type`, `target_id` and the `after`/`before` epoch millisecond bounds.",
    parameters: [
      ...backendListParams,
      queryParam("actor", { type: "string" }),
      queryParam("action", { type: "string" }),
      queryParam("target_type", { type: "string" }),
      queryParam("target_id", { type: "string" }),
      queryParam("after", { type: "integer" }, "Epoch milliseconds."),
      queryParam("before", { type: "integer" }, "Epoch milliseconds."),
    ],
    ...list(ref("AuditLog")),
    errors: [429],
  }),
  op("get", "/v1/stats", "Instance", "getInstanceStats", "Read instance statistics", {
    security: "backend",
    description: "Totals plus the last 30 UTC days of sign-ups and sign-ins, for the dashboard charts.",
    ...ok(ref("InstanceStats")),
    errors: [429],
  }),
];

