# Federation: connecting an external identity provider

OrbitID can delegate authentication to an external OpenID Connect provider, either as a **social provider**
(anyone may use it, from the sign-in screen) or as an **enterprise connection** (only the domains you list, and
it is picked automatically from the sign-in identifier). SAML 2.0 identity providers are supported as
enterprise connections too.

All three paths end in the same place: a verified external identity is turned into a user, an
`external_account` row and a session. What differs is how the identity is fetched and which settings decide
whether a new account may be created.

Everything below is also what `packages/server/test/federation/` exercises against real HTTP servers: a second
OrbitID instance acting as the OIDC provider (through discovery and through manual endpoints), a minimal OAuth
2.0 provider with a nested userinfo document, and a minimal SAML identity provider written in the test (including
metadata import).

## Claims that are mapped

| External claim | Becomes |
|---|---|
| `sub` (OIDC) / `NameID` or the mapped user-id attribute (SAML) | `external_accounts.provider_user_id` |
| `email`, `email_verified` (OIDC) / the mapped email attribute (SAML) | the user's primary email address; `email_verified` decides whether it counts as verified |
| `given_name` / `family_name` | the user's first and last name (only when the local field is empty) |
| `preferred_username` | `external_accounts.username` (not the OrbitID `username` identifier) |
| `picture` | `external_accounts.image_url` |
| `nonce` | checked against the nonce OrbitID sent; a mismatch refuses the login |

Rules that apply to every provider:

* A **verified** email that already belongs to a local user links the external identity to that user and signs
  them in. An **unverified** email never links: the flow becomes transferable to a sign-up, and the address is
  left unverified there so the user still has to prove it.
* The same external identity signing in again matches on `(provider, provider_user_id)` and creates no second
  user. Two different providers — including two `custom_*` providers on the same instance — keep separate
  account namespaces even when they report the same subject id.
* Sign-up creation is still gated by `signUp.mode` (`public` / `restricted` / `waitlist`), the allowlist and the
  blocklist. An existing linked account is unaffected by the sign-up mode.
* An access token returned by the provider is stored encrypted (`external_accounts.access_token_enc`) and can be
  read back through `GET /v1/client/me/external_accounts/:id/access_token`.

## Custom provider (OIDC or plain OAuth 2.0)

A `custom_<key>` provider is any external identity provider. `<key>` is yours: with `custom_acme` the strategy is
`oauth_custom_acme` and the callback path is `/v1/oauth_callback/custom_acme`. It can be OpenID Connect
(a discovery document or manual endpoints) or plain OAuth 2.0 with a userinfo endpoint.

1. At the identity provider, register a **confidential** client with the redirect URI
   `https://your-orbitid.example/v1/oauth_callback/custom_acme` (exact match; `http://localhost:<port>/…` while
   developing). Note its client id and secret. A public client with PKCE and no secret also works.
2. On the OrbitID instance, add it through `PATCH /v1/instance` (the dashboard's **Social connections** screen
   writes the same fields, and its **Add custom provider** button authors them):

   ```json
   {
     "social": {
       "custom_acme": {
         "enabled": true,
         "name": "Acme ID",
         "clientId": "…",
         "clientSecret": "…",
         "protocol": "oidc",
         "discoveryUrl": "https://id.acme.example/.well-known/openid-configuration",
         "scopes": ["openid", "profile", "email"],
         "clientAuthMethod": "client_secret_basic",
         "pkce": true,
         "trustEmailVerified": false,
         "logoUrl": "https://cdn.acme.example/icon.svg",
         "claimMapping": { "sub": "", "email": "", "emailVerified": "", "picture": "" },
         "authenticatableAtSignIn": true
       }
     }
   }
   ```

   `clientSecret` is sealed with the instance encryption key and never returned by the API (`••••` on read).

   **Manual endpoints.** When the provider publishes no discovery document, set `discoveryUrl` to an empty
   string and supply `authorizationUrl`, `tokenUrl`, `userinfoUrl`, and (for a signed ID token) `jwksUrl` and
   `issuer`. Discovery wins when both are present.

   **Token request shape.** `clientAuthMethod` is `client_secret_basic` (default) or `client_secret_post`.
   `pkce` (default `true`) sends S256; turn it off only for a provider that rejects PKCE.

   **Claim mapping.** Every `claimMapping` value is a dotted JSON path into the ID-token claims or userinfo
   document (`data.profile.contact.email` works). An empty value uses the provider's standard claim name. The
   mapped subject (`sub` by default) is what makes a returning account match, so it must be stable.

   **Trust email as verified.** `trustEmailVerified: true` marks the provider's email verified even without an
   `email_verified` claim. Only enable it when the provider actually checks addresses: a verified email is what
   links an external identity to an existing local account.

3. The provider appears in `GET /v1/client/environment` under `social` (with `logo_url`), and a client starts the
   flow with `POST /v1/client/sign_ins {"strategy": "oauth_custom_acme", "redirect_url": "…"}`.

The flow is authorization code + PKCE (S256 unless turned off) with a `nonce` when an ID token is verifiable.
OrbitID builds the authorization request from the discovery document or the manual endpoints, exchanges the code
at `token_endpoint`, and verifies the `id_token` against `jwks_uri`: signature, `iss` (discovery issuer or the
manual `issuer`), `aud` = your client id, expiry (60 s clock skew), and the nonce. A token that fails any of these
is refused outright — there is no fallback to `userinfo`, because that would let a forged token's claims be
replaced by someone else's. A key rotation is retried once against a freshly fetched JWKS.

If the provider has no verifiable ID token, its `userinfo_endpoint` supplies the profile (this is the normal case
for plain OAuth 2.0). All outbound calls go through the SSRF guard: a discovery document whose endpoints resolve
to a loopback, private, link-local or metadata address is refused unless `application.developmentMode` is on (or
`ORBITID_ALLOW_PRIVATE_NETWORKS=true`).

### Test a custom provider without saving

`POST /v1/instance/social/test` (secret key) resolves a discovery document or validates manual endpoints, probes
each endpoint, and reports the issuer, scopes, PKCE support and token-auth methods. It answers
`{ ok, endpoints, checks, warnings, errors }`, never throws for a bad provider URL, and saves nothing. The
dashboard's **Test connection** button calls it and shows the same result inline.

## Enterprise connection — OIDC

Enterprise connections are managed through the Backend API (`/v1/enterprise_connections`, secret key) or the
dashboard's Enterprise SSO screen.

```json
{
  "name": "Acme",
  "protocol": "oidc",
  "domains": ["acme.example"],
  "active": true,
  "allow_subdomains": false,
  "client_id": "…",
  "client_secret": "…",
  "discovery_url": "https://id.acme.example/.well-known/openid-configuration"
}
```

Before creating it, register `https://your-orbitid.example/v1/client/enterprise/oidc_callback/<connection id>`
at the provider. The connection id is only known after creation, so either create it with `active: false`, patch
`client_id`/`discovery_url` afterwards, or update the provider's redirect URI once the id is returned.

What happens at sign-in:

1. `POST /v1/client/sign_ins {"identifier": "user@acme.example"}` finds the active connection that claims the
   email's domain (`allow_subdomains` extends a claim to `*.acme.example`) and answers with the
   `enterprise_sso` first factor plus an `external_verification_redirect_url`.
2. `GET /v1/client/enterprise/start` stores a single-use state (with PKCE and a nonce), binds it to the browser
   and redirects to the provider.
3. The provider redirects back to `/v1/client/enterprise/oidc_callback/:id`. OrbitID consumes the state, checks
   the browser binding, exchanges the code, verifies the `id_token` (signature, issuer, audience, nonce,
   algorithm pinned to RS256/ES256/PS256/EdDSA, 60 s clock skew, one JWKS re-fetch on rotation) and fetches
   `userinfo` for anything the token omits.

On the first login, the verified external identity **just-in-time provisions** the account: OrbitID links an
existing local user with the same verified email, or carries the verified claims into a transferable sign-up so
the user finishes JIT provisioning without retyping them. Every later login matches the external account and
signs the same user in. `allow_idp_initiated` is only meaningful for SAML; OIDC logins always start at OrbitID.

## Enterprise connection — SAML 2.0

```json
{
  "name": "Acme",
  "protocol": "saml",
  "domains": ["acme.example"],
  "active": true,
  "idp_entity_id": "https://id.acme.example/metadata",
  "idp_sso_url": "https://id.acme.example/sso",
  "idp_certificate": "-----BEGIN CERTIFICATE-----\n…",
  "attribute_mapping": { "email": "mail", "first_name": "givenName", "last_name": "sn", "user_id": "uid" }
}
```

Give the identity provider OrbitID's service-provider metadata, served at
`/v1/saml/<connection id>/metadata` (entity id `/v1/saml/<connection id>`, ACS `/v1/saml/<connection id>/acs`).
`attribute_mapping` defaults to `{ email, firstName, lastName, nameID }`; `user_id` may also be `nameID`.

Instead of naming the entity id, SSO URL and certificate by hand, pass the IdP's own metadata:

```json
{ "protocol": "saml", "domains": ["acme.example"], "idp_metadata_xml": "<EntityDescriptor …>" }
```

or `"idp_metadata_url": "https://id.acme.example/metadata"`, which is fetched through the SSRF guard. OrbitID
reads the entity id, the HTTP-Redirect `SingleSignOnService` location and the `use="signing"` certificate. Any
explicit `idp_entity_id` / `idp_sso_url` / `idp_certificate` in the same request wins, so a value the document got
wrong can be corrected. The dashboard's SSO wizard accepts a metadata URL, a file upload, or pasted XML.

Validation performed on every response:

* The assertion signature, against `idp_certificate`. Assertions must be signed (`wantAssertionsSigned`); signing
  only the enclosing `Response` is not enough.
* The audience (`<sp entity id>`) and the timestamps (`NotBefore`/`NotOnOrAfter`, with 5 s of clock skew, and a
  24 h maximum assertion age).
* The status code, the signed `Destination` and the bearer `Recipient` — all must name this ACS.
* `InResponseTo` must answer an AuthnRequest OrbitID issued, unless `allow_idp_initiated` is set.
* Replay: every AuthnRequest id and every assertion id is remembered in `oauth_states` until it expires, and the
  RelayState is single use, so a captured response cannot be replayed into a fresh flow or another browser.

## Fields worth knowing

| Field | Effect |
|---|---|
| `domains` | Which email domains route to this connection. Case-insensitive, normalized to lower case. |
| `allow_subdomains` | Also claim `anything.<domain>`. |
| `active` | Inactive connections neither route nor accept assertions (the ACS answers 403). |
| `disable_additional_identifications` | A user linked through this connection cannot add an email address, phone number, password or social account, and cannot verify an identifier that was already pending. The `/me` routes answer `403 not_allowed_access`. |
| `sync_user_attributes` | On each SSO sign-in, update the local first name, last name and avatar from the provider's claims when the provider supplies them. Missing claims never clear a local value. Defaults to `true`. |
| `provider` | Free-form label stored with the connection, for your own bookkeeping. |

`disable_additional_identifications` is evaluated from the user's enterprise link (the `saml_<id>` or
`oidc_<id>` external account), not from the browser session, so it still applies after a password sign-in.
Removing an existing identifier or linked account is not blocked: the setting prevents new ways in, not the
routes a user already has.

## Operational notes

* Deleting an enterprise connection or disabling a social provider takes effect immediately; in-flight states
  still expire on their own after 10 minutes.
* A refused external login (denied consent, expired or mismatched state, a browser that did not start the flow,
  a failed token exchange) never shows a provider error inside OrbitID: the browser returns to the app's
  `redirect_url` with `__orbit_error` and `__orbit_error_message` query parameters, so the app can render its own
  error page. Nothing is created on a refused flow.
* Tokens returned by a provider are refreshed by signing in again; OrbitID does not call the provider's refresh
  endpoint on the user's behalf.
* The discovery document is cached in process for an hour, keyed by URL: changing `discovery_url` (enterprise
  connections also drop their stored copy) makes the next request resolve it again.
* `ORBITID_ALLOW_PRIVATE_NETWORKS=true` (server) relaxes the SSRF guard for every outbound URL, not only identity
  providers. Prefer `application.developmentMode` while developing against a local IdP.
