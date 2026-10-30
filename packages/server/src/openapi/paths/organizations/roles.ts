/** organizations paths: roles. */
import { arr, deletedObject, obj, ref } from "../../schema";
import { backendListParams, idPath, op, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { ok } from "../common";

export const operations: DocumentedOperation[] = [
  // ───────────── roles and permissions (Backend API) ─────────────
  op("get", "/v1/roles", "Organizations", "listRoles", "List roles", {
    security: "backend",
    description: "System roles and custom roles. Filter with `query`.",
    parameters: [...backendListParams, queryParam("query", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("Role")), total_count: { type: "integer" } }) },
    errors: [429],
  }),
  op("post", "/v1/roles", "Organizations", "createRole", "Create a role", {
    security: "backend",
    description:
      "Custom role keys are namespaced: `org:<feature>[:<permission>]` is an organization role (assigned through a " +
      "membership) and `app:<feature>[:<permission>]` is an instance role (assigned to a user with " +
      "`PUT /v1/users/{id}/roles`). `org:sys_*` and `app:sys_*` are reserved for seeded entries.",
    body: { schema: body.roleCreate },
    ...ok(ref("Role")),
    errors: [409, 422],
  }),
  op("get", "/v1/roles/{id}", "Organizations", "getRole", "Read a role", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Role")),
    errors: [404],
  }),
  op("patch", "/v1/roles/{id}", "Organizations", "updateRole", "Update a role", {
    security: "backend",
    description: "System roles cannot be modified (`403`). `permissions` replaces the whole set.",
    parameters: [idPath],
    body: { schema: body.roleUpdate },
    ...ok(ref("Role")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/roles/{id}", "Organizations", "deleteRole", "Delete a role", {
    security: "backend",
    description: "System roles cannot be deleted.",
    parameters: [idPath],
    success: { status: 200, schema: deletedObject("role") },
    errors: [403, 404],
  }),
  op("post", "/v1/roles/{id}/permissions", "Organizations", "setRolePermissions", "Replace a role's permissions", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.rolePermissions },
    ...ok(ref("Role")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/roles/{id}/permissions/{permissionId}", "Organizations", "removeRolePermission", "Remove one permission from a role", {
    security: "backend",
    parameters: [idPath, pathParam("permissionId", "Permission id or key.")],
    ...ok(ref("Role")),
    errors: [403, 404],
  }),
  op("get", "/v1/permissions", "Organizations", "listPermissions", "List permissions", {
    security: "backend",
    description: "Filter with `type` (`system` or `user`) and `query`.",
    parameters: [...backendListParams, queryParam("type", { type: "string", enum: ["system", "user"] }), queryParam("query", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("Permission")), total_count: { type: "integer" } }) },
    errors: [429],
  }),
  op("post", "/v1/permissions", "Organizations", "createPermission", "Create a permission", {
    security: "backend",
    description: "Custom keys must be namespaced as `org:<feature>:<permission>`.",
    body: { schema: body.permissionCreate },
    ...ok(ref("Permission")),
    errors: [409, 422],
  }),
  op("get", "/v1/permissions/{id}", "Organizations", "getPermission", "Read a permission", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Permission")),
    errors: [404],
  }),
  op("patch", "/v1/permissions/{id}", "Organizations", "updatePermission", "Update a permission", {
    security: "backend",
    description: "System permissions cannot be modified.",
    parameters: [idPath],
    body: { schema: body.permissionUpdate },
    ...ok(ref("Permission")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/permissions/{id}", "Organizations", "deletePermission", "Delete a permission", {
    security: "backend",
    description: "System permissions cannot be deleted.",
    parameters: [idPath],
    success: { status: 200, schema: deletedObject("permission") },
    errors: [403, 404],
  }),
];
