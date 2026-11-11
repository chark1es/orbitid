# Tinyauth

[Tinyauth](https://tinyauth.app) can use OrbitID as an upstream OAuth/OpenID Connect provider. Tinyauth then
protects Traefik, Caddy, Nginx and the apps behind them while users sign in on OrbitID.

Tinyauth's custom-provider mode uses **static endpoint URLs, `client_secret_post` and no PKCE**. Those are all
supported by default.

## 1. Create the application in OrbitID

Dashboard → **OAuth applications** → **Create application** (or `POST /v1/oauth_applications`):

| Field | Value |
|---|---|
| Name | `Tinyauth` |
| Redirect URI | `https://tinyauth.example.com/api/oauth/callback/orbitid` |
| Post-logout redirect URI | `https://tinyauth.example.com/login` (optional) |
| Public client | Off (Tinyauth keeps a secret) |
| Require PKCE | **Off** |
| Scopes | `openid profile email groups` |
| Groups claim | `all` (or `roles` if you only map roles) |
| Skip consent screen | On for a first-party installation |

Copy the `client_id` and the one-time `client_secret`.

> **Scopes are enforced.** OrbitID only allows the scopes listed on the application. Tinyauth sends
> `openid profile email groups` (as above): all four must be on the OrbitID app, and **Groups claim** must not
> be `none`. New applications default to `openid profile email` with **Groups claim: none**, so add `groups`
> and choose `all`/`roles` when you map groups. A request for an unconfigured scope fails with `invalid_scope`
> instead of silently returning nothing.

> The redirect path is `/api/oauth/callback/<provider-id>`. The provider id (`orbitid` here) is the lower-case
> identifier you choose in the Tinyauth environment variables below.

## 2. Configure Tinyauth

```yaml
services:
  tinyauth:
    environment:
      # endpoint values come from the OrbitID "Endpoints" panel
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_CLIENTID=oa_...
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_CLIENTSECRET=oas_...
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_AUTHURL=https://auth.example.com/oauth/authorize
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_TOKENURL=https://auth.example.com/oauth/token
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_USERINFOURL=https://auth.example.com/oauth/userinfo
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_REDIRECTURL=https://tinyauth.example.com/api/oauth/callback/orbitid
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_SCOPES=openid profile email groups
      - TINYAUTH_OAUTH_PROVIDERS_ORBITID_NAME=OrbitID
```

The issuer is `https://auth.example.com` (no trailing slash). Tinyauth reads the profile from userinfo, so
OrbitID returns `sub`, `preferred_username`, `name`, `email`, `email_verified` and `groups` there.

## 3. Map attributes (only if needed)

Tinyauth defaults to `preferred_username`, `name` and `groups`, which OrbitID already emits. If you renamed
claims in front of OrbitID, map them explicitly:

```yaml
- TINYAUTH_OAUTH_PROVIDERS_ORBITID_CLAIMS_USERNAME=preferred_username
- TINYAUTH_OAUTH_PROVIDERS_ORBITID_CLAIMS_NAME=name
```

Tinyauth does not require `sub`, but OrbitID always returns it. It is the stable user id.

## 4. Restrict who may sign in

Every OrbitID account can authenticate. Restrict access in Tinyauth with `TINYAUTH_OAUTH_WHITELIST`, or in
OrbitID with an allowlist, a restricted sign-up mode, or an organization membership.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `invalid_request: redirect_uri is not registered` | The URI in OrbitID must equal `https://<tinyauth>/api/oauth/callback/orbitid` exactly. |
| `invalid_client` | Copy the secret again with **Rotate secret**; the old one is invalid immediately. |
| Tinyauth shows no email | Grant the `email` scope and make sure the OrbitID user has a verified primary email. |
| Groups are empty | Grant the `groups` scope and check the app's **Groups claim** setting. |
| `issuer` mismatch | Use the exact issuer shown in OrbitID discovery, with no trailing slash. |
