import { useState } from "react";
import type { PaginatedList, PermissionJSON, RoleJSON } from "@orbitid/shared";
import { toast } from "sonner";
import { useShowOrganizations } from "../../lib/features";
import { api, useApi } from "../../lib/api";
import { unwrapList } from "../_config/data";
import { errorMessage, permissionFeature, permissionKeyError, roleKeyError } from "../_config/settings";
import {
  type RoleForm,
  type PermissionForm,
  EMPTY_ROLE,
  EMPTY_PERMISSION,
  rolePermissionKeys,
} from "./model";

export function useRolesPermissions() {
  const showOrganizations = useShowOrganizations();
  const [selectedScope, setScope] = useState<"app" | "org">("app");
  const scope = showOrganizations ? selectedScope : "app";
  const prefix = `${scope}:`;
  const rolesQuery = useApi<PaginatedList<RoleJSON>>(["roles", scope], `/roles?limit=100&query=${encodeURIComponent(prefix)}`);
  const permissionsQuery = useApi<PaginatedList<PermissionJSON>>(["permissions", scope], `/permissions?limit=100&query=${encodeURIComponent(prefix)}`);
  const roles = unwrapList<RoleJSON>(rolesQuery.data).filter((role) => role.key.startsWith(prefix));
  const permissions = unwrapList<PermissionJSON>(permissionsQuery.data).filter((permission) => permission.key.startsWith(prefix));
  const [roleOpen, setRoleOpen] = useState(false);
  const [roleForm, setRoleForm] = useState<RoleForm>(EMPTY_ROLE);
  const [roleSaving, setRoleSaving] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [permissionForm, setPermissionForm] = useState<PermissionForm>(EMPTY_PERMISSION);
  const [permissionSaving, setPermissionSaving] = useState(false);
  const [deleteRole, setDeleteRole] = useState<RoleJSON | null>(null);
  const [deletePermission, setDeletePermission] = useState<PermissionJSON | null>(null);
  const [deleting, setDeleting] = useState(false);

  const roleGroups = permissions.reduce<Record<string, PermissionJSON[]>>((groups, permission) => {
    const feature = permissionFeature(permission.key);
    (groups[feature] ??= []).push(permission);
    return groups;
  }, {});

  const openCreateRole = () => {
    setRoleForm({ ...EMPTY_ROLE, key: prefix });
    setRoleOpen(true);
  };
  const openEditRole = (role: RoleJSON) => {
    setRoleForm({
      id: role.id,
      key: role.key,
      name: role.name,
      description: role.description ?? "",
      creatorEligible: role.is_creator_eligible,
      permissionKeys: rolePermissionKeys(role),
    });
    setRoleOpen(true);
  };
  const openCreatePermission = () => {
    setPermissionForm({ ...EMPTY_PERMISSION, key: prefix });
    setPermissionOpen(true);
  };
  const openEditPermission = (permission: PermissionJSON) => {
    setPermissionForm({ id: permission.id, key: permission.key, name: permission.name, description: permission.description ?? "" });
    setPermissionOpen(true);
  };

  const roleErrors: string[] = [];
  const keyError = roleKeyError(roleForm.key);
  if (keyError) roleErrors.push(keyError);
  if (!roleForm.key.startsWith(prefix)) roleErrors.push(`Use a ${prefix} key for this scope.`);
  if (!roleForm.name.trim()) roleErrors.push("Role name is required.");
  if (roles.some((role) => role.key === roleForm.key.trim() && role.id !== roleForm.id)) roleErrors.push("A role with this key already exists.");

  const permissionErrors: string[] = [];
  const permissionError = permissionKeyError(permissionForm.key);
  if (permissionError) permissionErrors.push(permissionError);
  if (!permissionForm.key.startsWith(prefix)) permissionErrors.push(`Use a ${prefix} key for this scope.`);
  if (!permissionForm.name.trim()) permissionErrors.push("Permission name is required.");
  if (permissions.some((permission) => permission.key === permissionForm.key.trim() && permission.id !== permissionForm.id))
    permissionErrors.push("A permission with this key already exists.");

  const saveRole = async () => {
    if (roleErrors.length > 0) return;
    setRoleSaving(true);
    try {
      const body = {
        key: roleForm.key.trim(),
        name: roleForm.name.trim(),
        description: roleForm.description.trim(),
        is_creator_eligible: scope === "org" && roleForm.creatorEligible,
        permissions: roleForm.permissionKeys,
      };
      await api(roleForm.id ? "PATCH" : "POST", roleForm.id ? `/roles/${roleForm.id}` : "/roles", body);
      await rolesQuery.refetch();
      toast.success(roleForm.id ? "Role updated" : "Role created");
      setRoleOpen(false);
    } catch (error) {
      toast.error("Could not save role", { description: errorMessage(error) });
    } finally {
      setRoleSaving(false);
    }
  };

  const savePermission = async () => {
    if (permissionErrors.length > 0) return;
    setPermissionSaving(true);
    try {
      const body = { key: permissionForm.key.trim(), name: permissionForm.name.trim(), description: permissionForm.description.trim() };
      await api(permissionForm.id ? "PATCH" : "POST", permissionForm.id ? `/permissions/${permissionForm.id}` : "/permissions", body);
      await Promise.all([permissionsQuery.refetch(), rolesQuery.refetch()]);
      toast.success(permissionForm.id ? "Permission updated" : "Permission created");
      setPermissionOpen(false);
    } catch (error) {
      toast.error("Could not save permission", { description: errorMessage(error) });
    } finally {
      setPermissionSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteRole && !deletePermission) return;
    setDeleting(true);
    try {
      if (deleteRole) {
        await api("DELETE", `/roles/${deleteRole.id}`);
        await rolesQuery.refetch();
        toast.success("Role deleted");
        setDeleteRole(null);
      } else if (deletePermission) {
        await api("DELETE", `/permissions/${deletePermission.id}`);
        await permissionsQuery.refetch();
        await rolesQuery.refetch();
        toast.success("Permission deleted");
        setDeletePermission(null);
      }
    } catch (error) {
      toast.error("Could not delete", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  const togglePermission = (key: string, checked: boolean) => {
    setRoleForm((current) => ({
      ...current,
      permissionKeys: checked ? [...current.permissionKeys, key] : current.permissionKeys.filter((value) => value !== key),
    }));
  };

  return {
    setScope,
    roleOpen,
    setRoleOpen,
    roleForm,
    setRoleForm,
    roleSaving,
    permissionOpen,
    setPermissionOpen,
    permissionForm,
    setPermissionForm,
    permissionSaving,
    deleteRole,
    setDeleteRole,
    deletePermission,
    setDeletePermission,
    deleting,
    showOrganizations,
    scope,
    prefix,
    rolesQuery,
    permissionsQuery,
    roles,
    permissions,
    roleGroups,
    openCreateRole,
    openEditRole,
    openCreatePermission,
    openEditPermission,
    roleErrors,
    keyError,
    permissionErrors,
    permissionError,
    saveRole,
    savePermission,
    confirmDelete,
    togglePermission,
  };
}

export type RolesPermissionsController = ReturnType<typeof useRolesPermissions>;
