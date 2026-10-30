# Roles and permissions

OrbitID has two role namespaces. They are separated by the role **key prefix**, which is the single source of truth
for a role's scope — there is no column that can drift from it.

| Scope | Key prefix | Assigned to | Stored on | Claims |
| --- | --- | --- | --- | --- |
| Organization | `org:` | an organization membership | `organization_memberships.role_key` | `org_role`, `org_permissions` |
| Instance | `app:` | a user (by an operator) | `user_roles` | `roles`, `role_permissions` |

Both are ordinary custom roles created through the Backend API; `org:sys_*` and `app:sys_*` are reserved for seeded
entries, and the two system roles `org:admin` / `org:member` cannot be edited, deleted, or assigned as instance roles.

## Creating roles and permissions

```http
POST /v1/roles
{ "key": "org:billing", "name": "Billing", "permissions": ["org:sys_memberships:read"] }

POST /v1/roles
{ "key": "app:support", "name": "Support" }

POST /v1/permissions
{ "key": "app:reports:read", "name": "Read reports" }

POST /v1/roles/{id}/permissions
{ "permissions": ["app:reports:read"] }
```

A permission attached to a role must live in the same namespace as the role: attaching `app:reports:read` to
`org:billing` answers `422 form_param_value_invalid`. `GET /v1/roles` and `GET /v1/permissions` report `scope` on
every object.

`is_creator_eligible` and the `organizations.creatorRole` / `organizations.defaultRole` settings apply to organization
roles only; a save naming an `app:` key there is refused.

## Assigning roles

Organization roles are assigned through a membership or an invitation (`POST /v1/organizations/{id}/memberships`
with `role`, `PATCH …/memberships/{userId}`, `POST …/invitations`). An `app:` key is refused with `422`, because it
would leak an instance-scoped key into `org_role` and grant nothing.

Instance roles are assigned only by an operator:

```http
GET /v1/users/{id}/roles
{ "object": "user_roles", "user_id": "user_…", "roles": ["app:support"], "role_permissions": ["app:reports:read"] }

PUT /v1/users/{id}/roles
{ "roles": ["app:support"] }        # replaces the whole set; [] clears it
```

Rules that make this safe:

- The route lives on the Backend API (secret key or same-origin dashboard session). The Frontend API has no route that
  writes `user_roles`.
- Nothing a signed-in user can write reaches these rows: not `PATCH /v1/client/me`, not metadata, not the request body
  of any client call.
- Only `app:` keys that exist and are not system roles are accepted; anything else is a `422` and leaves the existing
  assignment untouched.
- A `PUT` revokes the user's sessions, preventing further token refresh until the user signs in again.
  `POST /v1/sessions/{id}/revoke` is the equivalent for a single session.

Offline JWT verification cannot discover a database revocation: a previously issued token remains valid until its
`exp` (60 seconds by default). Applications needing immediate revocation must check session status online in
addition to verifying the signature and expiry. Changing a role's permission set affects future token mints; it
does not rewrite tokens already issued.

## Claims and `has()`

The session JWT (and `UserJSON`) carries the instance roles as top-level claims:

```json
{
  "sub": "user_…", "sid": "sess_…",
  "org_id": "org_…", "org_slug": "acme", "org_role": "org:billing",
  "org_permissions": ["org:sys_memberships:read"],
  "roles": ["app:support"],
  "role_permissions": ["app:reports:read"]
}
```

`roles` and `role_permissions` are recomputed from the database on every mint, so a role change applies at the next
token refresh. They are in the reserved-claims list: neither `settings.session.customClaims` nor a JWT template can set
them (a template that tries answers `422`).

Server-side and in the SDKs, `has()` accepts either namespace:

```ts
auth.has({ role: "org:admin" })          // active organization membership
auth.has({ role: "app:support" })        // operator-assigned instance role
auth.has({ permission: "app:reports:read" })
// Node SDK also accepts a feature/permission pair for organization grants:
auth.has({ feature: "reports", permission: "read" })
```

Feature checks never infer instance permissions. React `has()` accepts exactly one check key; use the full
permission key for authorization rather than combining `feature` and `permission`. Browser checks only control
visibility; authorize protected operations on the server using a verified token.

In the Node SDK's `AuthContext` the two are separate fields — `roles` / `rolePermissions` next to `orgRole` /
`orgPermissions` — so an app can tell "this user supports the instance" from "this user is an admin of the active
organization".

## For the dashboard

- Read: `GET /v1/users/{id}/roles` → `{ object: "user_roles", user_id, roles, role_permissions }`.
- Write: `PUT /v1/users/{id}/roles` with `{ roles: string[] }`; it returns the same object and the *effective* set
  (a key that no longer exists is dropped).
- The role picker should list `GET /v1/roles?limit=100` and filter `scope === "instance"`; organization roles belong in
  the membership editor instead.
- After a successful `PUT`, re-read the user (`GET /v1/users/{id}`) and expect the sessions to be gone: show that the
  user must sign in again.
- `UserJSON.roles` / `UserJSON.role_permissions` are available on every user object, so a table can show the instance
  roles without a second request.
- Historical `SessionJSON.actor` is still present (null for every new session); it is display-only and cannot be set.

## Validation and errors

API key syntax: `org:`/`app:` followed by one or more `:`-separated
segments of lowercase letters, digits, `_` or `-` (each starting with a letter or digit). `org:team-lead`,
`app:support_2` and `org:billing:read` are all valid. Keys are compared for equality (or as a `prefix:*` permission
wildcard) and are never parsed into SQL or a route, so a hyphen is only a character.

| Situation | Response |
| --- | --- |
| Key without `org:`/`app:`, uppercase, or with a reserved `sys_` prefix | `422 form_param_format_invalid`, `meta.param_name = "key"` |
| Permission from the other namespace | `422 form_param_value_invalid`, `meta.param_name = "permissions"` (checked **before** any insert/update, so nothing is half-written) |
| `is_creator_eligible` on an `app:` role | `422 form_param_value_invalid`, `meta.param_name = "is_creator_eligible"` |
| Instance role on a membership/invitation | `422 form_param_value_invalid`, `meta.param_name = "role"` |
| Instance role that does not exist, or a system role | `422` (`org_role_not_found` / `form_param_value_invalid`) |
| `organizations.creatorRole` / `defaultRole` naming a missing or `app:` role | `422` (`org_role_not_found` / `form_param_format_invalid`), `meta.param_name = "organizations.creatorRole"` |
| Delete a role that is assigned (membership or `user_roles`) or is the creator/default role | `403 not_allowed_access` |
| Edit or delete a system role/permission | `403 not_allowed_access` |

Organization roles and instance roles are managed by the same endpoints; both keep working while
`organizations.enabled` is false, because instance roles do not depend on the organizations feature.

## Concurrent authorization updates

Replacing a user's instance-role set or a role's permission set is all-or-nothing. Each replacement locks its
stable parent before deleting/inserting grant rows, so concurrent requests produce one complete requested set,
never a merged set. Insert failures roll back the deletion. Individual permission add/remove operations take the
same parent lock. SQLite uses synchronous immediate transactions; Postgres holds the parent row lock until commit.

Disabling organizations suppresses organization membership/permission claims in newly minted session and OIDC
tokens; instance `app:` grants remain available. Already-issued offline JWTs retain their claims until expiry.
Instance-role assignments have a foreign key to the role key. Deleting a role cascades its assignments, so a
concurrent deletion cannot leave grants that revive when the same key is re-created. Upgrade migrations discard
orphaned assignments before adding that constraint. System-role permissions are read-only through every API.

Organization membership-role changes likewise affect newly minted tokens and live database authorization checks.
Existing third-party JWT consumers can retain the previous `org_role` until token expiry (60 seconds by default).
