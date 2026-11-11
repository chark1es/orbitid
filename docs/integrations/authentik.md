# Authentik

Authentik can use OrbitID as an upstream identity source. In Authentik this is called an **OAuth Source**
(provider type **OpenID Connect**); older versions call it **OpenID Connect Source**. The fields are the same.

OrbitID is the identity provider here. Authentik receives the user, creates or links a local Authentik user, and
can then apply its own policies, groups and applications.

## 1. Create the application in OrbitID

Dashboard → **OAuth applications** → **Create application**:

| Field | Value |
|---|---|
| Name | `Authentik` |
| Redirect URI | `https://authentik.example.com/source/oauth/callback/orbitid/` |
| Post-logout redirect URI | `https://authentik.example.com/` (optional) |
| Public client | Off |
| Require PKCE | **Off** (Authentik's source flow does not send a challenge) |
| Scopes | `openid profile email groups` |
| Groups claim | `all` |
| Skip consent screen | On for a first-party installation |

Copy the client ID and secret.

> **Scopes and the groups claim are opt-in.** Every scope the source requests must be listed on the OrbitID
> application (standard scopes included), and the app's **Groups claim** cannot be `none` if Authentik maps
> groups. New applications default to `openid profile email` with **Groups claim: none**, so add `groups` and
> choose `all` (or `roles`/`organizations`) here. Requesting a scope the app did not configure returns
> `invalid_scope`.

The redirect URI must include the trailing slash and the source slug (`orbitid`). If you name the source
differently, change both the slug and this URI together.

## 2. Create the OAuth Source in Authentik

**Directory → Federation & Social login → Create → OAuth Source**:

| Authentik field | Value |
|---|---|
| Name | `OrbitID` |
| Slug | `orbitid` |
| Provider type | `OpenID Connect` |
| Consumer key | OrbitID `client_id` |
| Consumer secret | OrbitID `client_secret` |
| Authorization URL | `https://auth.example.com/oauth/authorize` |
| Token URL | `https://auth.example.com/oauth/token` |
| Userinfo URL | `https://auth.example.com/oauth/userinfo` |
| Scopes | `openid profile email groups` |
| Subject key | `sub` |
| Username key | `preferred_username` |
| Email key | `email` |
| Name key | `name` |
| Group key | `groups` |

Enable the source and attach it to a flow (**Authentication → Flows & Stages**, or the default
`default-source-authentication` flow). Authentik shows an **OrbitID** button on the sign-in page.

## 3. Group mapping

OrbitID's `groups` claim contains stable keys, not display names:

```json
["acme", "org:admin", "app:reviewer"]
```

- Organization slugs: `acme`
- Organization roles: `org:admin`
- Instance roles: `app:reviewer`

In Authentik, map these to local groups with a **Group membership** policy or a source property mapping. A
simple mapping in the source's **Group property** field:

```python
return request.userinfo.get("groups", [])
```

If you only want role keys, set the OrbitID app's **Groups claim** to `roles`. If you only want organization
names, set it to `organizations`.

## 4. Optional: let Authentik's users use OrbitID only

Authentik still owns its local user records. To prevent password sign-in on Authentik, disable the
`default-authentication-identification` stage or restrict it with a policy; the OrbitID source remains the only
way in.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Authentik callback says `redirect_uri` mismatch | Register `https://<authentik>/source/oauth/callback/<slug>/` **with** the trailing slash. |
| `invalid_client` | Use the current secret; rotation invalidates the old one immediately. |
| Username is an id | Set **Username key** to `preferred_username`. OrbitID always emits it, falling back to the email local part. |
| Groups do not map | Grant `groups`, set **Group key** to `groups`, and check the source's group property mapping. |
| `invalid_scope` | The requested scope is not enabled on the OrbitID application. Add it to **Scopes**. |
| Token rejected after a proxy change | Use the exact issuer from discovery (`https://auth.example.com`, no slash) in both places. |

## Reverse direction

To use Authentik as the identity provider **for** OrbitID, configure an Enterprise OIDC connection instead:
see [docs/FEDERATION.md](../FEDERATION.md). That is the opposite trust direction and uses OrbitID as the relying
party.
