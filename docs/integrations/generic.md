# Generic OIDC/OAuth clients

Every client below uses the same four values from the OrbitID **OAuth applications → Endpoints** panel:

```text
Issuer:                 https://auth.example.com
Authorization endpoint: https://auth.example.com/oauth/authorize
Token endpoint:         https://auth.example.com/oauth/token
UserInfo endpoint:      https://auth.example.com/oauth/userinfo
JWKS / discovery:       https://auth.example.com/oauth/jwks
                        https://auth.example.com/.well-known/openid-configuration
```

Create one OrbitID application per client. Unless the client sends a PKCE challenge, leave **Require PKCE**
off; all of these are confidential clients with a secret.

## Grafana

```ini
[auth.generic_oauth]
enabled = true
name = OrbitID
allow_sign_up = true
client_id = oa_...
client_secret = oas_...
scopes = openid profile email groups
auth_url = https://auth.example.com/oauth/authorize
token_url = https://auth.example.com/oauth/token
api_url = https://auth.example.com/oauth/userinfo
use_pkce = false
login_attribute_path = preferred_username
role_attribute_path = contains(groups[*], 'org:admin') && 'Admin' || 'Viewer'
```

OrbitID redirect URI: `https://grafana.example.com/login/generic_oauth`.
`role_attribute_path` reads the `groups` claim; grant the `groups` scope and set the app's **Groups claim** to
`all` or `roles`.

## Gitea / Forgejo

```ini
[oauth2]
ENABLE = true

[oauth2_client]
ENABLE_AUTO_REGISTRATION = true
ACCOUNT_LINKING = auto
OPENID_CONNECT_DISCOVERY_URL = https://auth.example.com/.well-known/openid-configuration
CLIENT_ID = oa_...
CLIENT_SECRET = oas_...
SCOPES = openid profile email groups
```

OrbitID redirect URI: `https://gitea.example.com/user/oauth2/orbitid/callback`.
The source name in Gitea is the last segment (`orbitid`). Create the authentication source under
**Site Administration → Authentication Sources → Add Authentication Source → OAuth2 → OpenID Connect**.

## Nextcloud (Social Login / OpenID Connect)

Nextcloud's **Social Login** app → **OpenID Connect** provider:

| Field | Value |
|---|---|
| Internal name | `orbitid` |
| Client ID | `oa_...` |
| Client secret | `oas_...` |
| Discovery endpoint | `https://auth.example.com/.well-known/openid-configuration` |
| Scope | `openid profile email groups` |
| Redirect URI | `https://cloud.example.com/apps/sociallogin/custom_oidc/orbitid` |

Register the redirect URI in OrbitID exactly. If the app does not read discovery, enter the authorization and
token endpoints from the panel instead.

## Portainer

**Settings → Authentication → OAuth → Custom OIDC**:

| Field | Value |
|---|---|
| Client ID | `oa_...` |
| Client secret | `oas_...` |
| Authorization URL | `https://auth.example.com/oauth/authorize` |
| Access token URL | `https://auth.example.com/oauth/token` |
| Resource URL (userinfo) | `https://auth.example.com/oauth/userinfo` |
| Redirect URL | `https://portainer.example.com/` |
| User identifier | `sub` |
| Scopes | `openid profile email` |

Portainer uses `sub` as the stable identifier. Register `https://portainer.example.com/` as the redirect URI.

## Immich

```yaml
services:
  immich-server:
    environment:
      - IMMICH_OIDC_ISSUER=https://auth.example.com
      - IMMICH_OIDC_CLIENT_ID=oa_...
      - IMMICH_OIDC_CLIENT_SECRET=oas_...
      - IMMICH_OIDC_REDIRECT_URI=https://immich.example.com/auth/login
      - IMMICH_OIDC_SCOPE=openid profile email
      - IMMICH_OIDC_BUTTON_TEXT=Sign in with OrbitID
      - IMMICH_OIDC_AUTO_REGISTER=true
```

OrbitID redirect URI: `https://immich.example.com/auth/login`.
For the mobile app also register `app.immich:///oauth-callback` and set `IMMICH_OIDC_MOBILE_REDIRECT_URI`.
`IMMICH_OIDC_ISSUER` must be the exact issuer, without a trailing slash.

## oauth2-proxy

```bash
oauth2-proxy \
  --provider=oidc \
  --oidc-issuer-url=https://auth.example.com \
  --client-id=oa_... \
  --client-secret=oas_... \
  --redirect-url=https://app.example.com/oauth2/callback \
  --scope="openid profile email groups" \
  --cookie-secret="$(openssl rand -base64 32)" \
  --email-domain="*"
```

OrbitID redirect URI: `https://app.example.com/oauth2/callback`.
With `--provider=oidc`, oauth2-proxy uses discovery, stores tokens in its encrypted cookie, refreshes them with
the `refresh_token` grant, and calls `/oauth/end_session` on sign-out when `--oidc-issuer-url` advertises it.

## Traefik forward-auth

Traefik delegates the decision to oauth2-proxy; OrbitID is the identity provider behind it.

```yaml
http:
  middlewares:
    orbitid-auth:
      forwardAuth:
        address: http://oauth2-proxy:4180/oauth2/auth
        trustForwardHeader: true
        authResponseHeaders:
          - X-Auth-Request-User
          - X-Auth-Request-Email
```

Protect a router with `middlewares: [orbitid-auth]`. The browser is sent to oauth2-proxy, which starts the
OrbitID authorization-code flow.

## Cloudflare Access and other OIDC clients

Choose **SAML/OIDC → OIDC** in Cloudflare Zero Trust, set the issuer to the exact OrbitID issuer, and add the
Cloudflare callback (`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`) as an OrbitID redirect URI.
Grant `openid profile email groups` if you map Cloudflare groups.

The same fields work for Outline, Paperless-ngx, Open WebUI, Vaultwarden's SSO build, the Jellyfin SSO plugin,
Keycloak as a broker, and Authelia's OIDC client:

| Client field | OrbitID value |
|---|---|
| Issuer / discovery | `https://auth.example.com` or `https://auth.example.com/.well-known/openid-configuration` |
| Authorization URL | `https://auth.example.com/oauth/authorize` |
| Token URL | `https://auth.example.com/oauth/token` |
| Userinfo / profile URL | `https://auth.example.com/oauth/userinfo` |
| JWKS URL | `https://auth.example.com/oauth/jwks` |
| Client ID | `oa_...` |
| Client secret | `oas_...` (confidential clients only) |
| Scopes | `openid profile email` (+ `groups`, `offline_access` when needed) |
| Redirect URI | The exact callback the client prints; register it verbatim |
| Logout URL | `https://auth.example.com/oauth/end_session` |

## Common problems

| Symptom | Cause |
|---|---|
| `redirect_uri` mismatch | The value registered in OrbitID differs by scheme, host, port, path or trailing slash. |
| `invalid_client` | Wrong secret, or the secret was rotated. Rotate and copy the new one. |
| `invalid_scope` | The client asked for a scope the application does not allow. Add it to the app's scopes. |
| Issuer mismatch / token rejected | The client's issuer has a trailing slash or a different scheme/host. Use the value from discovery. |
| User has no email | Grant `email` and make the user's primary email verified. |
| Groups are empty | Grant `groups`; check the app's **Groups claim** setting and the user's organization/role memberships. |
| Refresh fails after a long idle period | The refresh token expired (`refresh_token_lifetime_seconds`) or was revoked. Sign in again. |
