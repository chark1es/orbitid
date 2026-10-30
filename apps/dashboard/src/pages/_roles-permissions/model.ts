import type { PermissionJSON, RoleJSON } from "@orbitid/shared";

export interface RoleForm {
  id?: string;
  key: string;
  name: string;
  description: string;
  creatorEligible: boolean;
  permissionKeys: string[];
}
export interface PermissionForm {
  id?: string;
  key: string;
  name: string;
  description: string;
}

export const EMPTY_ROLE: RoleForm = { key: "app:", name: "", description: "", creatorEligible: false, permissionKeys: [] };
export const EMPTY_PERMISSION: PermissionForm = { key: "app:", name: "", description: "" };

export const rolePermissionKeys = (role: RoleJSON): string[] =>
  (role.permissions ?? []).map((permission) => (typeof permission === "string" ? permission : permission.key));

export const isSystemPermission = (permission: PermissionJSON): boolean =>
  permission.type === "system" || permission.key.startsWith("org:sys_");
