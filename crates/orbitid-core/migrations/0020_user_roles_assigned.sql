-- Instance default role (`roles.defaultRole`, docs/RBAC.md).
--
-- A user's instance roles come from one of two sources:
--   * assigned: the user has custom (non-`app:sys_*`) `user_roles` rows, or an
--     operator explicitly set the set (possibly to nothing) through
--     `PUT /v1/users/{id}/roles`. System grants (`app:sys_*`) never decide the
--     source; they are always added on top;
--   * default:  nothing was assigned, so the user inherits the configured
--     instance default role, resolved when roles are read.
--
-- The rows alone cannot tell "explicitly no roles" from "never assigned", so
-- this flag records the former. It is false for every existing user: a user
-- with custom rows is already "assigned" by having them, and no default is
-- configured on an upgraded install until an operator picks one.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS instance_roles_assigned boolean NOT NULL DEFAULT false;
