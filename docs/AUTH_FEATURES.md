# Email codes as a second factor, trusted devices, and anonymous accounts

Three related authentication features. Everything here is off until an operator turns it on, so an
existing instance behaves exactly as before after an upgrade.

- [1. Email code as a second factor](#1-email-code-as-a-second-factor)
- [2. Trusted devices](#2-trusted-devices)
- [3. Anonymous (guest) accounts](#3-anonymous-guest-accounts)
- [Security notes](#security-notes)

---

## 1. Email code as a second factor

The account's verified email address can be used as a second factor, next to an authenticator app, a
text message code and backup codes.

### Enabling it

```jsonc
// PATCH /v1/instance  (or the dashboard's User & Auth settings)
{
  "attributes": {
    "emailAddress": { "usedForSecondFactor": true }
  }
}
```

`attributes.emailAddress.enabled` must also be true; the user needs at least one **verified** email
address. Nothing else is required — the code is sent with the same mail transport and lifetime
(`email.codeLifetimeSeconds`, `email.codeLength`) as every other email code.

### API

`GET /v1/client/environment` lists `"email_code"` in `auth_config.second_factors` while the setting is on.

```http
POST /v1/client/sign_ins/:id/prepare_second_factor
{ "strategy": "email_code", "email_address_id": "idn_e_..." }   // email_address_id optional

POST /v1/client/sign_ins/:id/attempt_second_factor
{ "strategy": "email_code", "code": "123456" }
```

The code is single use, is compared in constant time against its stored sha256, expires after
`email.codeLifetimeSeconds`, and counts attempts (`maxAttempts`, default 5) like every other code;
a wrong code also increments the account's failed-attempt counter.

### A second factor is never the first factor

Email is **not** offered as a second factor when the first factor was `email_code` or `email_link`:
`supported_second_factors` omits it and `prepare_second_factor` answers
`400 strategy_for_user_invalid`. Covering one mailbox twice is not a second factor.

### SDK

```ts
await orbit.signIn.prepareSecondFactor({ strategy: "email_code", emailAddressId });
await orbit.signIn.attemptSecondFactor({ strategy: "email_code", code });
```

The React `<SignIn>` second-factor step offers "Email code" in the method picker next to the
authenticator app, text message and backup code options, and prepares the code when it is selected.

---

## 2. Trusted devices

A browser can be remembered after a successful second factor, so the same browser skips the second
factor until the remembered device expires.

### Enabling it

```jsonc
{
  "session": {
    "trustedDevicesEnabled": true,   // default false: the checkbox never appears and tokens are ignored
    "trustedDeviceDays": 30          // 1..365
  }
}
```

### Flow

1. The user completes a second factor with `trust_device: true`.
2. The server stores a row in `trusted_devices` with **only the sha256** of an opaque 32-byte token,
   a label derived from the user agent ("Trusted browser", "Trusted mobile browser", "Trusted tablet"),
   the IP address, and `expires_at = now + trustedDeviceDays`.
3. The plaintext token is the `__orbit_trusted` cookie: `HttpOnly`, `SameSite=Lax`, `Secure` when the
   API is served over https, `Path=/`, scoped to the API host.
4. On a later sign-in, a valid, unexpired, unrevoked token that belongs to **the same user** completes
   the sign-in without a second factor. The session is created as verified and carries
   `second_factor_skipped_by_trusted_device: true` in the session JSON, so the dashboard can show
   "second factor skipped: trusted device".
5. Every use **rotates** the token value; the original `expires_at` is kept (there is no sliding window).

A token is refused — and the cookie cleared — when it is expired, revoked, tampered with, already
rotated (replay), or belongs to a different account. With `mfa.required`, a trusted device only works
for users who have already enrolled a factor.

### Revocation

All of a user's trusted devices are revoked when the user:

- changes or sets a password (`POST /me/change_password`, `PATCH /v1/users/:id`),
- removes their password (`POST /me/remove_password`, `DELETE /v1/users/:id/password`),
- removes a second factor (`DELETE /me/totp`, turning off the last second-factor phone number,
  `DELETE /v1/users/:id/mfa`),
- resets a password through the sign-in flow,
- is banned or locked (`POST /v1/users/:id/ban`, `/lock`, or automatically after too many failed attempts).

### Endpoints

```
GET    /v1/client/me/trusted_devices            → { response: TrustedDeviceJSON[] }
DELETE /v1/client/me/trusted_devices/:id        → { response: { object: "trusted_device", id, deleted: true } }

GET    /v1/users/:id/trusted_devices            → TrustedDeviceJSON[]
DELETE /v1/users/:id/trusted_devices/:device_id → { object: "trusted_device", id, deleted: true }
```

`DELETE /v1/client/me/trusted_devices/:id` is scoped to the caller: another user's device id answers
`404 resource_not_found`, exactly like an unknown id. Expired and revoked devices are not listed, and
the token hash is never serialized.

```jsonc
// TrustedDeviceJSON
{
  "object": "trusted_device",
  "id": "tdev_...",
  "user_id": "user_...",
  "label": "Trusted browser",
  "user_agent": "Mozilla/5.0 ...",
  "ip_address": "203.0.113.7",
  "expires_at": 1790000000000,
  "last_used_at": 1789000000000,
  "revoked_at": null,
  "created_at": 1788000000000,
  "updated_at": 1789000000000
}
```

### SDK and components

```ts
// environment
orbit.environment.authConfig.trustedDevices; // { enabled, days }

await orbit.signIn.attemptSecondFactor({ strategy: "totp", code, trustDevice: true });

const devices = await orbit.user.getTrustedDevices();
await orbit.user.revokeTrustedDevice(devices[0].id);
```

The public environment exposes `auth_config.trusted_devices: { enabled, days }`. `<SignIn>` renders a
"Trust this browser for N days" checkbox in the second-factor step only when `enabled` is true (checked
by default), and `<UserProfile>`'s Security page renders a "Trusted devices" list with a revoke button
per device. `UserProfile` hides the section entirely when the feature is off.

---

## 3. Anonymous (guest) accounts

A guest account has no identifier at all: no email, no phone number, no password, no OAuth account.
It gets an active session immediately and upgrades **in place** as soon as it gains a way to sign in.

### Enabling it

```jsonc
{
  "anonymous": {
    "enabled": true,                 // default false: the strategy is refused
    "retentionSeconds": 2592000      // 30 days; 0 keeps guests forever
  }
}
```

### Creating one

```http
POST /v1/client/sign_ups
{ "strategy": "anonymous", "unsafe_metadata": {} }
```

Creates a user with `is_anonymous: true`, no identifiers, and an active session. The sign-up completes
immediately (`status: "complete"`, `created_session_id`, `created_user_id`).

Guests are cheap to mint, so the endpoint is rate-limited per IP at **10 per hour** — much tighter than
ordinary sign-ups. When bot protection is configured for sign-up (`security.captchaProvider` +
`security.captchaSecret`), the CAPTCHA token is required exactly as for any other sign-up.

The session JWT carries `"anonymous": true` while the account is a guest. The claim cannot be forged
through `session.customClaims`: it is a protected claim derived from the user row on every mint.

### Upgrading in place

The flag flips to `false` — and the claim disappears from the next JWT — as soon as the user, through
the existing `/me` endpoints:

- adds and **verifies** an email address (`POST /me/email_addresses`, `…/attempt_verification`),
- adds and **verifies** a phone number (same flow),
- sets or changes a password (`POST /me/change_password`; `current_password` is optional when the
  account has no password yet),
- connects an external account (`POST /me/external_accounts` → OAuth callback with `kind: "connect"`).

Unverified identifiers and profile fields (name, username, metadata, picture) do not upgrade the account.

### What guests may not do

Until they upgrade, a guest account:

- may not create an organization (`organization_creation_not_allowed`),
- may not create, list, revoke or manage API keys (`not_allowed_access`),
- cannot appear as a member of an existing organization unless an administrator adds it (guests are never
  matched by an email/domain invitation, having no email address).

Everything else on `/me` works: profile fields, metadata, profile picture, sessions, passkey enrolment
and deleting the account.

### Cleanup

A background worker (started from `startServer`, alongside the webhook worker; it ticks every 5 minutes)
deletes guests whose `last_active_at` is older than `anonymous.retentionSeconds`. `retentionSeconds: 0`
disables cleanup. Up to 100 users are removed per tick, each with a conditional
`DELETE … WHERE is_anonymous = true AND last_active_at < cutoff … RETURNING`, so a user who upgraded or
was active between the read and the delete is never touched. Deleting a guest removes its sessions,
identifiers and trusted devices through the usual cascades and emits `user.deleted`.

### API and webhooks

`UserJSON` includes `is_anonymous` on both APIs, so every `user.*` webhook payload carries it.
The Backend API user list accepts `?is_anonymous=true|false`:

```http
GET /v1/users?is_anonymous=true
```

### SDK and components

```ts
const signUp = await orbit.signUp.createAnonymous();
await orbit.setActive({ session: signUp.createdSessionId! });
orbit.user?.isAnonymous; // true until the account gains an identifier

// after adding and verifying an email address:
orbit.user?.isAnonymous; // false
```

The public environment exposes `auth_config.anonymous: { enabled }`. `useUser()` returns
`isAnonymous` next to `user`, `isLoaded` and `isSignedIn`.

---

## Security notes

- **Only hashes at rest.** Second-factor codes and trusted-device tokens are stored as sha256 hashes;
  codes are compared with a constant-time comparison (`safeEqual`).
- **Second factors stay second factors.** A second factor must differ from the first one: email is never
  offered after an email sign-in, so one compromised mailbox cannot satisfy both steps.
- **Rotation without a sliding window.** Each use of a trusted-device token rotates its value; a replayed
  cookie therefore fails, and the lifetime never extends itself. Revocation is immediate because the
  server checks the row on every sign-in, not a client-held claim.
- **Cookie scope.** `__orbit_trusted` is `HttpOnly` and `SameSite=Lax`, so scripts on the app origin cannot
  read it and cross-site form posts cannot send it. It is marked `Secure` whenever the API base URL is
  https. Setting a custom `cookie.domain` on the SDK does not widen it: the server sets it on the API host.
- **No enumeration.** Guests have no identifier, so an unknown identifier is never "a guest account";
  the sign-in flow's existing enumeration-protection behaviour is unchanged.
- **Rate limits.** Guest creation is limited to 10 per IP per hour. `prepare_second_factor` (30/min) and
  `attempt_second_factor` (60/min) limits are unchanged; individual codes additionally cap attempts at 5.
- **Upgrade is driven by the server.** `is_anonymous` is derived from what the account can actually do
  (a verified identifier, a password, or a connected account), never from a client-supplied field.
