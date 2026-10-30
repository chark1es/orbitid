/** backend paths: users. */
import { arr, obj, ref, str } from "../../schema";
import { backendListParams, idPath, op, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { list, ok } from "../common";
import { userId, multi } from "./common";

export const operations: DocumentedOperation[] = [
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
      "Updates profile fields, metadata and limits. Sign-in material is not operator-editable: `password`, " +
      "`password_digest`, `totp_secret`, `backup_codes` and the `primary_*_id` fields are refused with `403 " +
      "not_allowed_access`, because the user changes them from their own session. `sign_out_of_other_sessions` still " +
      "ends their sessions. Emits `user.updated`.",
    parameters: [userId],
    body: { schema: body.userUpdate },
    ...ok(ref("User")),
    errors: [403, 404, 409, 422],
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
  op("post", "/v1/users/{id}/verify_password", "Users (backend)", "verifyUserPassword", "Check a user's password (removed)", {
    security: "backend",
    description:
      "Removed: an unmetered check outside the sign-in lockout is a password-guessing oracle. Always answers `403` " +
      "`not_allowed_access`; the sign-in flow does this with failure accounting.",
    parameters: [userId],
    body: { schema: body.passwordCheck },
    success: { status: 403 },
    errors: [404],
  }),
  op("post", "/v1/users/{id}/verify_totp", "Users (backend)", "verifyUserTotp", "Check a user's TOTP code (removed)", {
    security: "backend",
    description: "Removed for the same reason as `verifyUserPassword`: a 30-second code must not be brute-forceable. Always answers `403` `not_allowed_access`.",
    parameters: [userId],
    body: { schema: body.totpCheck },
    success: { status: 403 },
    errors: [404],
  }),
  op("get", "/v1/users/{id}/trusted_devices", "Users (backend)", "listUserTrustedDevices", "List a user's trusted devices", {
    security: "backend",
    parameters: [userId],
    ...ok(arr(ref("TrustedDevice"))),
    errors: [404],
  }),
  op("delete", "/v1/users/{id}/trusted_devices/{device_id}", "Users (backend)", "revokeUserTrustedDevice", "Revoke a user's trusted device", {
    security: "backend",
    description: "The browser must complete its second factor on its next sign-in.",
    parameters: [userId, pathParam("device_id", "Trusted device id (`tdev_…`).")],
    ...ok(ref("TrustedDevice")),
    errors: [404],
  }),
  op("delete", "/v1/users/{id}/mfa", "Users (backend)", "resetUserMfa", "Reset a user's MFA (removed)", {
    security: "backend",
    description:
      "Removed: clearing somebody's second factor is what an account takeover starts with. Always answers `403` " +
      "`not_allowed_access`; the user removes their factor from their own session (`DELETE /me/totp`).",
    parameters: [userId],
    success: { status: 403 },
    errors: [404],
  }),
  op("delete", "/v1/users/{id}/password", "Users (backend)", "removeUserPassword", "Remove a user's password (removed)", {
    security: "backend",
    description: "Removed: always answers `403` `not_allowed_access`. The user removes their own password with `POST /me/remove_password`.",
    parameters: [userId],
    success: { status: 403 },
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
  op("get", "/v1/users/{id}/oauth_access_tokens/{provider}", "Users (backend)", "getUserOAuthTokens", "Read a user's provider tokens (removed)", {
    security: "backend",
    description:
      "Removed: a third-party access token lets the holder act as the user at the provider. Always answers `403` " +
      "`not_allowed_access`. The user reads their own token with `GET /me/external_accounts/:id/access_token`.",
    parameters: [userId, pathParam("provider", "Provider key, for example `google`.")],
    success: { status: 403 },
    errors: [404],
  }),
  op("get", "/v1/users/{id}/roles", "Users (backend)", "listUserRoles", "List a user's instance roles", {
    security: "backend",
    description:
      "Instance-wide (`app:...`) roles assigned to the user. They travel in the session token as `roles` and " +
      "`role_permissions`, independent of `org_role`.",
    parameters: [userId],
    ...ok(ref("UserRoles")),
    errors: [404],
  }),
  op("put", "/v1/users/{id}/roles", "Users (backend)", "setUserRoles", "Replace a user's instance roles", {
    security: "backend",
    description:
      "Operator-only. `roles` replaces the whole set; only `app:...` roles that are not system roles are accepted. " +
      "The user's sessions are revoked so the next token carries the new claims.",
    parameters: [userId],
    body: { schema: body.userRolesSet },
    ...ok(ref("UserRoles")),
    errors: [404, 422],
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
  op("post", "/v1/email_addresses", "Users (backend)", "createEmailAddress", "Add an email address to a user (removed)", {
    security: "backend",
    description:
      "Removed: an address the operator can attach and verify is one they control, so it becomes a sign-in and " +
      "password-reset destination they own. Always answers `403` `not_allowed_access`. Identifiers are created with " +
      "`POST /v1/users`; afterwards the user manages them at `/v1/client/me/email_addresses`.",
    body: { schema: body.emailAddressCreate },
    success: { status: 403 },
    errors: [404],
  }),
  op("patch", "/v1/email_addresses/{id}", "Users (backend)", "updateEmailAddress", "Verify or promote an email address (removed)", {
    security: "backend",
    description: "Removed: `verified: true` claims a mailbox the operator does not hold, and `primary` re-points sign-in. Always answers `403` `not_allowed_access`.",
    parameters: [idPath],
    body: { schema: body.identifierUpdate },
    success: { status: 403 },
    errors: [404],
  }),
  op("delete", "/v1/email_addresses/{id}", "Users (backend)", "deleteEmailAddress", "Delete an email address (removed)", {
    security: "backend",
    description: "Removed: deleting a sign-in identifier locks the user out. Always answers `403` `not_allowed_access`; the user removes it from their own session.",
    parameters: [idPath],
    success: { status: 403 },
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
  op("post", "/v1/phone_numbers", "Users (backend)", "createPhoneNumber", "Add a phone number to a user (removed)", {
    security: "backend",
    description:
      "Removed: attaching a verified number, and especially `default_second_factor`, installs a second factor the " +
      "operator holds. Always answers `403` `not_allowed_access`; the user adds and verifies numbers from their own session.",
    body: { schema: body.phoneNumberCreate },
    success: { status: 403 },
    errors: [404],
  }),
  op("patch", "/v1/phone_numbers/{id}", "Users (backend)", "updatePhoneNumber", "Verify or promote a phone number (removed)", {
    security: "backend",
    description: "Removed: verification and second-factor promotion are user actions. Always answers `403` `not_allowed_access`.",
    parameters: [idPath],
    body: { schema: body.phoneNumberUpdate },
    success: { status: 403 },
    errors: [404],
  }),
  op("delete", "/v1/phone_numbers/{id}", "Users (backend)", "deletePhoneNumber", "Delete a phone number (removed)", {
    security: "backend",
    description: "Removed: always answers `403` `not_allowed_access`; the user removes their own number.",
    parameters: [idPath],
    success: { status: 403 },
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
];
