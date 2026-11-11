# Email codes as a second factor, trusted devices, and anonymous accounts

Three related authentication features. Everything here is off until an operator turns it on, so an
existing instance behaves exactly as before after an upgrade.

- [1. Email code as a second factor](#1-email-code-as-a-second-factor)
- [2. Trusted devices](#2-trusted-devices)
- [3. Anonymous (guest) accounts](#3-anonymous-guest-accounts)
- [Social sign-in and federation](#social-sign-in-and-federation)
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

The channel and the exact identifier used as the first factor are not offered again:
`supported_second_factors` omits that email or phone number, and both `prepare_second_factor` and
`attempt_second_factor` refuse it with `400 strategy_for_user_invalid`. This covers `email_code`,
`email_link` and `reset_password_email_code` for email, and `phone_code` / `reset_password_phone_code`
for SMS. Another verified email or phone can still be used, and TOTP or a backup code remains available:
covering one mailbox or handset twice is not a second factor.

When several verified addresses can serve as the second factor, pass `email_address_id` to
`prepare_second_factor`. The code is checked against that address, not whichever address happens to be
first on the account.

### Recovery is bound to the prepared factor

`prepare_first_factor` records the strategy and the verification row it created. `attempt_first_factor`
refuses a different `strategy` with `400 client_state_invalid` — for `email_code`, `email_link`,
`phone_code` and both `reset_password_*` strategies — so a valid code for one channel cannot be submitted
under another channel's name. `password` is the exception: it issues no prepared artifact and is validated
by its own credential check plus the sign-in state gate, so after preparing an email code a caller may still
complete the sign-in with the account password (the UI's "Use another method" path). The verified reset
record, not the request body, determines the recovered channel and identifier; `reset_password` re-derives
them from that record before it escalates to MFA.

The recovery authorization is single use. `reset_password` consumes the verified record with a conditional
update before it writes the password, so replaying the same code — even concurrently — finds it spent and
returns `400 client_state_invalid` without another change. `prepare_first_factor` and `attempt_first_factor`
are also refused unless the sign-in is still waiting for a first factor, so a sign-in that is already at
`needs_new_password`, `needs_second_factor` or `complete` cannot be walked back to re-authorize a reset. The
same state gate rejects replayed `email_code`, `phone_code` and `email_link` attempts after they produced a
session or escalated to the second factor.

**Recovery ends the attacker's access.** After the new password is written, `reset_password` ends every other
session, revokes every OIDC grant and every trusted device, and only then sends the notification email; a mail
delivery failure never skips the revocation. The recovering browser receives a fresh session with the new
password. `password.signOutOfOtherSessionsOnReset` defaults to `true` (separate from the password-change
preference `password.signOutOfOtherSessionsOnChange`, which defaults to `false`).

With `mfa.required`, recovery still does not bypass the second factor. If the account has enrolled MFA but
the only eligible factor is the same mailbox or handset that recovery just used, the password change
completes and the sign-in returns `needs_first_factor` with `first_factor_verification.strategy: "password"`
and error `needs_second_factor`; no session is created. The user signs in with the new password, and the
normal password flow then asks for the second factor. An account that has never enrolled a factor keeps the
previous behaviour (a pending session when the instance offers a factor to enrol).

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

- changes or sets a password (`POST /me/change_password`),
- removes their password (`POST /me/remove_password`),
- removes a second factor (`DELETE /me/totp`, or turning off the last second-factor phone number),
- resets a password through the sign-in flow,
- is banned or locked (`POST /v1/users/:id/ban`, `/lock`, or automatically after too many failed attempts).

An operator cannot clear a password or a second factor on someone else's behalf: `DELETE /v1/users/:id/password`,
`DELETE /v1/users/:id/mfa` and the credential fields of `PATCH /v1/users/:id` answer `403 not_allowed_access`
(see [API.md](API.md)). Ban and lock remain operator actions and revoke credentials' shortcuts by ending trust.

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
It gets an active session immediately and upgrades **in place** as soon as it gains a verified way to be found again.

### Enabling it

```jsonc
{
  "anonymous": {
    "enabled": true,                 // default false: the strategy is refused
    "retentionSeconds": 0            // opt-in; 0 (default) keeps guests forever
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
- connects an external account (`POST /me/external_accounts` → OAuth callback with `kind: "connect"`).

Unverified identifiers, a password and profile fields (name, username, metadata, picture) do not upgrade the
account. A guest cannot set a password until it has a verified email or phone number, and adding an address or
number goes through the same allowlist, blocklist, subaddress and disposable-domain checks as a sign-up, so a guest
cannot get around restricted sign-up.

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
deletes guests whose `last_active_at` is older than `anonymous.retentionSeconds`. Retention is opt-in:
`retentionSeconds: 0` is the default and keeps guests forever. A guest that still has a live (active or
pending) session is never deleted, even when it looks idle: retention is housekeeping, not a sign-out, and
deleting the row would cascade into that session. The guest is purged on a later tick once its sessions have
ended. Up to 100 users are removed per tick, each with a conditional
`DELETE … WHERE is_anonymous = true AND last_active_at < cutoff AND NOT EXISTS (live session) … RETURNING`, so a
user who upgraded or was active between the read and the delete is never touched. Deleting a guest removes its
sessions, identifiers and trusted devices through the usual cascades and emits `user.deleted`.

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

## Social sign-in and federation

Built-in presets cover Google, GitHub, GitLab, Discord, Microsoft, Apple, Facebook, X/Twitter, LinkedIn,
Slack, Twitch, Spotify, Bitbucket, Dropbox, Notion, HubSpot, TikTok, Coinbase, LINE, Linear, Hugging Face,
Box, Atlassian, Xero and Zoom. Each is just a credential pair in **Social connections**; nothing is gated by
a plan.

Anything else is a `custom_<key>` provider: OpenID Connect through a discovery document **or** manual
endpoints, plain OAuth 2.0 with a userinfo endpoint, dotted claim/JSON-path mapping, `client_secret_basic`
or `client_secret_post`, PKCE on or off, a logo URL and an optional "trust email as verified" switch.
**Test connection** checks the endpoints without saving. Enterprise SAML 2.0 and OIDC connections add
domain routing and JIT provisioning. See [FEDERATION.md](FEDERATION.md) for the full contract, the claim
rules and the security checks (nonce, issuer, audience, rotated JWKS, clock skew, SSRF guard).

## Security notes

- **Only hashes at rest.** Second-factor codes and trusted-device tokens are stored as sha256 hashes;
  codes are compared with a constant-time comparison (`safeEqual`).
- **Second factors stay second factors.** A second factor must differ from the first one: the same email
  address is never offered after an email sign-in, and the same phone number is never offered after an
  SMS sign-in (including the reset-password strategies), so one compromised mailbox or handset cannot
  satisfy both steps.
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
  (a verified identifier or a connected account), never from a client-supplied field.
