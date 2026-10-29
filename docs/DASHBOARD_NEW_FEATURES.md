# New server features in the dashboard and the test site

Where the email-code second factor, trusted devices, guest accounts, the device authorization grant,
JWT access tokens and the server-side handshake appear in the two operator-facing surfaces. The
protocol details live in `AUTH_FEATURES.md`, `OIDC.md` and `HANDSHAKE.md`; this page maps them to
screens.

## Dashboard user pages

### Users list (`/users`)

- A `Guest` status chip (word plus dot, info tone) sits next to the existing `Banned`, `Locked` and
  `MFA` chips for any user with `is_anonymous: true`. A guest replaces the plain `Active` chip, so
  the two never contradict each other.
- **Account type** filter: `All` / `Registered` / `Guests`. It sends the Backend API filter
  `is_anonymous=true|false`; `All` omits the parameter. The value is serialised as a string because
  the shared list-path builder treats `false` as "no filter". The existing status, MFA, search, date
  and sort behaviour is unchanged.

### User detail (`/users/:id`)

- **Guest account** notice above the tabs: what a guest is, that it upgrades in place, and that it
  cannot create organizations or API keys. The header also carries the `Guest` chip.
- **Trusted devices** tab: `GET /v1/users/:id/trusted_devices`, one row per live device with label,
  IP address, last used and expiry. Revoke asks for confirmation and states the consequence ("the
  browser must complete the second factor on its next sign-in"), then calls
  `DELETE /v1/users/:id/trusted_devices/:device_id`. Empty, loading and error states say what the
  list will contain and what to do next.
- **Security tab**: the MFA summary lists email code as a second factor when
  `attributes.emailAddress.usedForSecondFactor` is on, with a note that email is never offered when
  the first factor was an email code or link. When trusted devices are off, the panel says so and
  points at the Sessions setting.
- **Sessions tab**: a session with `second_factor_skipped_by_trusted_device: true` carries a
  `Second factor skipped: trusted device` chip under its status. The Activity board already showed
  the same fact as its row detail.

## Test site

### Feature matrix (`/`)

New sections, each built from the running instance:

| Section | Source |
| --- | --- |
| Email | `email.provider` plus the `resendApiKeySet` / `smtpUrlSet` markers from `GET /v1/instance`; a public environment mail field is preferred if a future version exposes one. Secret values are never read or shown. |
| Trusted devices | `auth_config.trusted_devices` (`enabled`, `days`). |
| Guest accounts | `auth_config.anonymous.enabled`, plus the retention period from the settings snapshot. |
| OIDC provider | `oidcProvider.accessTokenFormat` and `deviceAuthorizationEnabled` (secret key only). |
| Handshake | Always on; names the route and the redirect rule. |

Email code was added to the second-factor rows, so it appears as `Enabled` as soon as the instance
offers it.

### Pages

- `/guest` — `signUp.createAnonymous()`, then `setActive`, `useUser().isAnonymous`, the raw
  `anonymous` claim from a freshly minted token, and an upgrade panel that adds and verifies an email
  address through the normal `/me` flows.
- `/device` — registers or picks an OAuth application with the secret key, starts
  `POST /oauth/device_authorization` from the server, shows the user code and verification link, and
  polls `POST /oauth/token` once or every interval. The device code stays in dev-server memory; only
  the user code and link reach the browser.
- `/account` — unchanged prebuilt `<UserProfile>`, with a note that its Security page lists trusted
  devices (and hides the section while the feature is off) and that email code appears in the
  second-factor picker.
- `/inspector` — `isAnonymous`, a second-factor row driven by the raw
  `second_factor_skipped_by_trusted_device` field (the SDK session resource does not copy it), and a
  trusted-devices table with per-device revoke.
- `/api-lab` — adds `/api/handshake`, `/api/device` (discovery, probe, start) and `/api/email-test`.

## Server-side helpers

`GET /api/handshake` requests a handshake for the site's own origin and reports the redirect instead
of following it. `GET /api/device` reads the discovery document and probes the device grant with a
made-up client id, so a `404` means the grant is off; `POST /api/device` starts a real authorization
for a client id. `POST /api/email-test` calls `POST /v1/instance/email_test` with the secret key and
returns the transport that delivered the message.

## Gaps in the packages this work could not change

- `@orbitid/react`'s `SessionResource` does not expose `secondFactorSkippedByTrustedDevice`, and
  `@orbitid/js`'s `Session` class does not copy the field from the wire JSON. The Inspector therefore
  reads `/v1/client/sessions` directly. Adding the field to both would let components show it without
  a second request.
- `@orbitid/react`'s `SignUpResource`, `EmailAddressResource` and `OrbitIDInstance` type the
  documented SDK methods (`createAnonymous`, `prepareVerification`, `attemptVerification`,
  `refreshClient`) as `unknown` or omit them, so the guest page casts to local interfaces. Typing them
  would remove those casts.
