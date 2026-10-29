# Passkeys (WebAuthn)

Passkeys let a user sign in with a device unlock — Touch ID, Windows Hello, a phone's screen lock, or a
hardware security key — instead of a password or an emailed code. OrbitID is a WebAuthn relying party: the
server issues the challenges and verifies attestations and assertions with `@simplewebauthn/server`; the
browser and the authenticator hold the private keys.

Passkeys are **off by default**. Turn them on in the instance settings:

```jsonc
{
  "attributes": {
    "passkey": { "enabled": true, "usedForFirstFactor": true }
  }
}
```

`enabled` gates registration and the WebAuthn ceremonies. `usedForFirstFactor` additionally gates *signing
in* with a passkey; with it `false` an existing passkey cannot start a sign-in, and it disappears from
`GET /v1/client/environment`'s `auth_config.first_factors` (which is what drives the prebuilt components).

There is no separate second-factor mode: a passkey is always a first factor. MFA is unaffected — a user
with TOTP enrolled still has to present it after a passkey, exactly as after a password.

## What the browser needs

WebAuthn is a browser API with hard platform rules. An instance works only when all of these hold:

- **A secure context.** `https://` anywhere, or `http://localhost` / `http://127.0.0.1` in development.
  Plain `http://` on any other hostname is refused by the browser before OrbitID sees a request.
- **A real page origin.** The credential is created for the page's origin, not the API's. If your app is
  served from `https://app.example.com` and calls an API at `https://api.example.com`, the page origin
  is what matters (see the limitation below).
- **No iframes without permission.** A cross-origin `<iframe>` needs `publickey-credentials-create` and
  `publickey-credentials-get` in its `allow` attribute. Top-level pages need nothing.
- **A supported browser.** Current Chrome, Edge, Safari and Firefox. Conditional UI (autofill in the
  username field) needs Chrome/Edge 108+, Safari 16+ or Firefox 119+; elsewhere it simply does not offer
  autofill and the button flow still works.

The browser SDK uses `@simplewebauthn/browser` (`startRegistration`, `startAuthentication`), so nothing
else has to be wired up: `user.createPasskey()` and `signIn.authenticateWithPasskey()` drive the whole
ceremony, and `authenticateWithPasskey({ autofill: true })` requests conditional UI.

## RP ID and origin rules

Two values define a passkey's scope, and both are derived from the **page** origin:

| Page URL | RP ID (`rp.id`) | Origin checked |
|---|---|---|
| `http://localhost:3000` | `localhost` | `http://localhost:3000` |
| `http://localhost:5173` (Vite) | `localhost` | `http://localhost:5173` |
| `https://app.example.com` | `app.example.com` | `https://app.example.com` |
| `https://app.example.com:8443` | `app.example.com` | `https://app.example.com:8443` |
| `https://auth.example.com` (API) + `https://app.example.com` (app) | `app.example.com` | `https://app.example.com` |

- The **RP ID is the hostname without the port** — WebAuthn has no notion of ports, so a passkey made on
  `localhost:3000` also works on `localhost:5173`. The same is true in production: `app.example.com` and
  `app.example.com:8443` share one RP ID.
- The **origin includes the scheme and the port** and is compared exactly. Changing the scheme, the host
  or the port invalidates every existing passkey for that app.
- **Subdomains:** the RP ID must be the page's host or a registrable suffix of it. A passkey scoped to
  `example.com` works on `app.example.com`, but OrbitID scopes to the exact page host, which is the
  stricter and safer choice. Registering on `app.example.com` and then serving the app from
  `auth.example.com` is a different RP ID: users must register again.

### How OrbitID picks them

`relyingParty()` in `packages/server/src/services/passkeys.ts`:

1. The request's `Origin` header — **if** `requestOriginAllowed()` trusts it (it must be the configured
   app URL, an entry in `application.allowedOrigins` / `allowedRedirectOrigins`, the instance base URL, or
   a localhost origin while `application.developmentMode` is on).
2. Otherwise `application.homeUrl` (the app URL configured in the dashboard).
3. Otherwise `ORBITID_BASE_URL`.

The chosen pair is stored with the challenge, and the verification step uses the stored pair — not
whatever the finishing request claims. A ceremony therefore cannot be moved to another origin by editing
the follow-up request, and a challenge presented twice fails.

For a production deployment set `application.homeUrl` (or list real origins under
`application.allowedOrigins`) and turn `application.developmentMode` off. Otherwise the browser's `Origin`
header is not trusted and ceremonies silently fall back to the instance URL, which is usually an API host
the browser never sees.

### When the API host differs from the app host

This works, and it is the normal split deployment: the app is on `https://app.example.com`, the API on
`https://api.example.com`, and the app lists both origins as trusted. The browser runs the ceremony on the
app origin, so the credential belongs to `app.example.com`, and the assertion is verified against that
origin.

The limitation to know about: **the browser will not let one origin use a credential scoped to another.**
If the page is `app.example.com` but the passkey was created on `auth.example.com`, the browser reports no
matching credential — this is not something a server setting can relax. Keep every route that runs the
ceremony on one stable origin, and do not move the app to a new subdomain without expecting users to
re-register.

The other half of the same rule: `homeUrl` (or an allowed origin) must be the **app** URL, never the API
URL. If it is the API URL, a request whose `Origin` the instance does not trust falls back to an RP ID the
browser cannot satisfy.

## Self-service API

All under `/v1/client`, cookie or bearer authenticated:

```
GET    /me/passkeys
POST   /me/passkeys                                { name?, authenticator_type? }  → registration options
POST   /me/passkeys/:id/attempt_verification       { public_key_credential, name? }
PATCH  /me/passkeys/:id                            { name }
DELETE /me/passkeys/:id                            (needs a recent first-factor verification)
```

Sign-in happens through the ordinary state machine:

```
POST /sign_ins                        { strategy: "passkey" }                # discoverable, no identifier
POST /sign_ins                        { identifier, strategy: "passkey" }    # identifier first
POST /sign_ins/:id/prepare_first_factor { strategy: "passkey" }               # options in first_factor_verification.nonce
POST /sign_ins/:id/attempt_first_factor { strategy: "passkey", public_key_credential }
```

`prepare_first_factor` returns the full `PublicKeyCredentialRequestOptions` JSON in the `nonce` field. For
the identifier-first flow `allowCredentials` lists that user's passkeys; for the discoverable flow it is
empty and the authenticator picks. The session records `auth_method: "passkey"`.

A successful assertion also advances the stored signature counter and sets `last_used_at`. Challenges
are single-use: a second submission of the same challenge is refused, while a *failed* verification (for
example a cancelled or retried ceremony) returns the challenge so the user can try again, up to five
attempts inside the five-minute window.

## Troubleshooting

**The browser says the operation is not allowed.** The page is not a secure context, or the `rp.id` the
server sent does not match the page host. Open the page over `https://` or `localhost` and compare the
`rp.id` in `first_factor_verification.nonce` with `location.hostname`.

**`SecurityError` / "The relying party ID is not a registrable domain suffix of the current domain".**
`application.homeUrl` (or the trusted `Origin`) points at a different host from the page. Fix the app URL
so it is the origin users actually browse.

**`NotAllowedError` with no prompt.** The user dismissed the prompt, the platform has no authenticator, or
the page origin is not the one the credential was created for. On desktop Linux, a passkey provider (for
example a phone paired over Bluetooth) or a security key is needed.

**Sign-in works but `user.passkeys` stays empty.** `GET /me/passkeys` lists only credentials whose
attestation was verified; a `POST /me/passkeys` that never got its `attempt_verification` leaves no row by
design, so a stale row cannot block `excludeCredentials`.

**"This authenticator is already registered".** The credential already exists. `POST /me/passkeys` sends
every existing credential in `excludeCredentials`, so the authenticator should not have offered it again;
this usually means the same key was registered against a second account.

**"Passkey registration expired" / "Too many passkey attempts".** The five-minute challenge window passed,
or five failed verifications were spent on it. Start the ceremony again; nothing is stored until it
succeeds.

**Verification fails only in production.** Check that the browser's `Origin` is listed. An untrusted
origin makes the server fall back to `homeUrl`, and if `homeUrl` is the API host the origin check fails.
Setting `application.developmentMode: false` is what stops localhost origins from being trusted.

**"Passkeys are disabled for this instance" / "Sign-in with passkeys is not enabled".** Check both
`attributes.passkey.enabled` and `attributes.passkey.usedForFirstFactor`.

## Tests

`packages/server/test/support/virtual-authenticator.ts` is a software authenticator: it generates ES256
(`-7`) and RS256 (`-257`) keys with `node:crypto`, and builds the `clientDataJSON`, the `authenticatorData`
(RP ID hash, UP/UV/BE/BS flags, counter), a CBOR-encoded `attestationObject` with `fmt: "none"` and the
assertion signature exactly as a browser returns them. `packages/server/test/passkeys-*.test.ts` drive the
real HTTP API with it, including wrong origin, wrong RP ID hash, tampered challenges, replays, counter
regression, forged keys, expired challenges, duplicate credentials, deleted credentials and banned or
locked users — no mocking of the WebAuthn code path anywhere.
