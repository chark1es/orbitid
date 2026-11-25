# Organization-owned OAuth applications

OrbitID's OAuth applications (`/v1/oauth_applications`, see [OIDC.md](OIDC.md)) can belong to an organization.
`organization_id` on `POST`/`PATCH /v1/oauth_applications` sets the owner; `null` (the default, and every application
created before this release) keeps it **instance-wide**, open to every user who can sign in, exactly as before.

In the dashboard, pick the owner on the OAuth applications page, see an organization's applications on its
**Applications** tab, and manage a user's cross-organization access on their **App access** tab.

## Who may use an application

When an application has an owner, a user may obtain codes or tokens for it only if they are:

1. a member of the owning organization, or
2. granted access to that specific application by an operator (an *access grant*).

Everyone else is refused wherever a grant or token would be issued:

| Where | What a refused user gets |
|---|---|
| `GET /oauth/authorize` | redirect to the client with `error=access_denied` (after sign-in, so nothing beyond the registered `client_id`/`redirect_uri` is revealed) |
| `GET /oauth/consent_info` | `404 resource_not_found`, the same answer as an unknown `client_id` |
| `POST /oauth/consent` | a `redirect_url` carrying `error=access_denied` and no code |
| device approval (`/oauth/device`, `POST /v1/client/oauth/device/approve`) | the code is denied: `403 not_allowed_access` to the approver, `access_denied` to the polling device |
| `POST /oauth/token` (`authorization_code`, `refresh_token`) | `invalid_grant`, "The user is not allowed to use this application" |
| `GET /oauth/userinfo`, `POST /oauth/introspect` | `401 invalid_token` / `{ "active": false }` |

The token endpoint re-checks the rule inside its issuing transaction (under the user and application row locks), so
a code issued just before access was lost cannot be exchanged, and a refresh token stops rotating even if the change
and the refresh raced.

## Granting access across organizations

Access grants are operator-only (secret key or dashboard session); there is no Frontend API for them.

```bash
# let a contractor who is not a member of the owning organization use the application
curl -X POST http://localhost:4000/v1/oauth_applications/oa_123/access_grants \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"user_id":"user_456"}'

curl http://localhost:4000/v1/oauth_applications/oa_123/access_grants -H "Authorization: Bearer sk_test_..."
curl http://localhost:4000/v1/users/user_456/oauth_application_access_grants -H "Authorization: Bearer sk_test_..."
curl -X DELETE http://localhost:4000/v1/oauth_applications/oa_123/access_grants/user_456 \
  -H "Authorization: Bearer sk_test_..."
```

Creating a grant is idempotent (`201` when created, `200` when it already existed). A grant on an instance-wide
application has no effect until the application gets an owner.

`GET /v1/oauth_applications?organization_id=org_…` lists one organization's applications
(`organization_id=null`: only the instance-wide ones). Grants and owner changes are written to the audit log
(`oauth_application_access_grant.created` / `.deleted`, `oauth_application.organization_changed`). There are no
webhook events for OAuth applications, so none are emitted for these either.

## What losing access does to issued tokens

Each change that narrows access revokes the affected user's codes, access tokens and refresh tokens **for that
application** in the same transaction as the change:

- **Revoking an access grant** revokes the user's grants unless they are still a member of the owning organization.
- **Removing a membership** (remove, leave, organization deletion) revokes the user's grants on the organization's
  applications unless they hold an access grant for them. This is in addition to the
  [organization-authority revocation](OIDC.md#organization-changes-revoke-organization-authority).
- **Assigning or changing the owner** revokes the grants of every user the new owner does not entitle. Making an
  application instance-wide (`organization_id: null`) widens access and revokes nothing.

A revoked refresh token cannot mint new tokens, and opaque access tokens stop working at `userinfo` and
`introspect` at once. An access **JWT** that a resource server verifies offline stays valid until its `exp` (the
application's access-token lifetime, 300 s by default); keep that lifetime short for applications where access
changes must take effect quickly. The user's browser session is never ended by these changes.

An organization that owns applications cannot be deleted (`409 organization_has_applications`): reassign or delete
its applications first. If its last member's account is deleted, the organization is kept so the applications keep
their owner.

## Locking

The rule is `orbitid_identity::app_access`. Every issuer (code exchange, refresh, device approval and poll, consent)
checks it with `user_may_use_application_on` **after** its user key-share (rank 3): it reads the owner under
`FOR SHARE` on the application row (rank 10a in [LOCK_ORDER.md](LOCK_ORDER.md)) and the membership and access-grant
rows plainly. The changes that narrow access meet issuers on one of those two rows:

| Change | Lock order | Why no issued row is missed |
|---|---|---|
| Remove a membership (remove, leave, organization deletion) | user `FOR UPDATE`→organization→memberships→grants | issuers key-share the user; the set-based revocation runs after the delete |
| Revoke an access grant | user `FOR UPDATE`→application `FOR SHARE`→access row→grants | same |
| Assign or change the owner | organization `FOR KEY SHARE`→application `FOR UPDATE`→grants | the update conflicts with the issuers' `FOR SHARE`, so it waits for them, and later issuers read the new owner |
| Grant access | user key-share→application `FOR SHARE`→insert | widens access only |
| Delete the application | application `FOR UPDATE`→grants→cascade into consents, device codes, access grants | the application is locked before its grant rows (an issuer holds the application, then claims a grant row; the old grants-first order could cycle with it) |

None of these takes per-family advisory locks: the user or application lock already keeps issuers out. Consent
takes the user key-share, then the application, then the consent row. An organization that owns applications cannot
be deleted, and user deletion keeps such an organization when its last member goes; both check with the
organization row locked, and assigning an owner key-shares it, so no assignment can slip in between.
Tests: `crates/orbitid-oidc/tests/org_app_access.rs`.
