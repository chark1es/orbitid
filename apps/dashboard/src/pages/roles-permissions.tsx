import { useState } from "react";
import type { PaginatedList, PermissionJSON, RoleJSON } from "@orbitid/shared";
import {
  Button,
  Input,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@orbitid/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "../lib/api";
import { unwrapList } from "./_config/data";
import {
  errorMessage,
  formatDate,
  isSystemRole,
  permissionFeature,
  permissionKeyError,
  roleKeyError,
} from "./_config/settings";
import {
  CheckboxRow,
  ConfirmDialog,
  DetailSheet,
  EmptyState,
  ErrorAlert,
  Field,
  MetaChip,
  PageHeader,
  RuledTable,
  TableSkeleton,
  ValidationSummary,
} from "./_config/ui";

interface RoleForm {
  id?: string;
  key: string;
  name: string;
  description: string;
  creatorEligible: boolean;
  permissionKeys: string[];
}
interface PermissionForm {
  id?: string;
  key: string;
  name: string;
  description: string;
}

const EMPTY_ROLE: RoleForm = { key: "org:", name: "", description: "", creatorEligible: false, permissionKeys: [] };
const EMPTY_PERMISSION: PermissionForm = { key: "org:", name: "", description: "" };

const rolePermissionKeys = (role: RoleJSON): string[] =>
  (role.permissions ?? []).map((permission) => (typeof permission === "string" ? permission : permission.key));

const isSystemPermission = (permission: PermissionJSON): boolean =>
  permission.type === "system" || permission.key.startsWith("org:sys_");

export default function Page() {
  const rolesQuery = useApi<PaginatedList<RoleJSON>>(["roles"], "/roles?limit=100");
  const permissionsQuery = useApi<PaginatedList<PermissionJSON>>(["permissions"], "/permissions?limit=100");
  const roles = unwrapList<RoleJSON>(rolesQuery.data);
  const permissions = unwrapList<PermissionJSON>(permissionsQuery.data);
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
    setRoleForm(EMPTY_ROLE);
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
    setPermissionForm(EMPTY_PERMISSION);
    setPermissionOpen(true);
  };
  const openEditPermission = (permission: PermissionJSON) => {
    setPermissionForm({ id: permission.id, key: permission.key, name: permission.name, description: permission.description ?? "" });
    setPermissionOpen(true);
  };

  const roleErrors: string[] = [];
  const keyError = roleKeyError(roleForm.key);
  if (roleKeyError(roleForm.key) && roleForm.key !== "org:") roleErrors.push(keyError ?? "");
  if (!roleForm.name.trim()) roleErrors.push("Role name is required.");
  if (roles.some((role) => role.key === roleForm.key.trim() && role.id !== roleForm.id)) roleErrors.push("A role with this key already exists.");

  const permissionErrors: string[] = [];
  const permissionError = permissionKeyError(permissionForm.key);
  if (permissionError && permissionForm.key !== "org:") permissionErrors.push(permissionError);
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
        is_creator_eligible: roleForm.creatorEligible,
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
      await permissionsQuery.refetch();
      await rolesQuery.refetch();
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles & permissions"
        description="Organization RBAC. System roles and permissions are read-only. Custom entries use org:<name> and org:<feature>:<action>."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={openCreatePermission}>
              <Plus className="size-4" aria-hidden /> Permission
            </Button>
            <Button size="sm" onClick={openCreateRole}>
              <Plus className="size-4" aria-hidden /> Role
            </Button>
          </div>
        }
      />

      {rolesQuery.error ? <ErrorAlert error={errorMessage(rolesQuery.error)} onRetry={() => void rolesQuery.refetch()} /> : null}
      {permissionsQuery.error ? <ErrorAlert error={errorMessage(permissionsQuery.error)} onRetry={() => void permissionsQuery.refetch()} /> : null}

      <Tabs defaultValue="roles">
        <TabsList>
          <TabsTrigger value="roles">Roles ({roles.length})</TabsTrigger>
          <TabsTrigger value="permissions">Permissions ({permissions.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="roles" className="mt-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Roles</h2>
            <p className="text-xs text-muted-foreground">Roles bundle permissions and attach to organization memberships.</p>
          </div>
          {rolesQuery.isLoading ? (
            <TableSkeleton />
          ) : roles.length === 0 ? (
            <EmptyState title="No roles" description="The server seeds system roles at boot. Add a custom role to grant your own permissions." />
          ) : (
            <RuledTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead className="text-right">Permissions</TableHead>
                  <TableHead>Creator eligible</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.map((role) => {
                  const system = isSystemRole(role as RoleJSON & { is_system?: boolean });
                  return (
                    <TableRow key={role.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{role.name}</p>
                            <code className="font-data text-xs text-muted-foreground">{role.key}</code>
                          </div>
                          {system ? <MetaChip>System</MetaChip> : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-data text-xs">{rolePermissionKeys(role).length}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{role.is_creator_eligible ? "Yes" : "No"}</TableCell>
                      <TableCell className="font-data text-xs text-muted-foreground">{formatDate(role.updated_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" disabled={system} onClick={() => openEditRole(role)} title="Edit">
                            <Pencil className="size-4" aria-hidden />
                            <span className="sr-only">Edit {role.name}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive"
                            disabled={system}
                            onClick={() => setDeleteRole(role)}
                            title="Delete"
                          >
                            <Trash2 className="size-4" aria-hidden />
                            <span className="sr-only">Delete {role.name}</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </RuledTable>
          )}
        </TabsContent>

        <TabsContent value="permissions" className="mt-4 space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold">Permissions</h2>
            <p className="text-xs text-muted-foreground">The Frontend API checks these keys and exposes them on session tokens.</p>
          </div>
          {permissionsQuery.isLoading ? (
            <TableSkeleton />
          ) : permissions.length === 0 ? (
            <EmptyState title="No permissions" description="The server seeds system permissions at boot." />
          ) : (
            <RuledTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Permission</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {permissions.map((permission) => {
                  const system = isSystemPermission(permission);
                  return (
                    <TableRow key={permission.id}>
                      <TableCell>
                        <p className="text-sm font-medium">{permission.name}</p>
                        <code className="font-data text-xs text-muted-foreground">{permission.key}</code>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{system ? "System" : "Custom"}</TableCell>
                      <TableCell>
                        <span className="block max-w-[34rem] truncate text-xs text-muted-foreground">{permission.description || "No description"}</span>
                      </TableCell>
                      <TableCell className="font-data text-xs text-muted-foreground">{formatDate(permission.updated_at)}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon-sm" disabled={system} onClick={() => openEditPermission(permission)} title="Edit">
                            <Pencil className="size-4" aria-hidden />
                            <span className="sr-only">Edit {permission.name}</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="text-destructive"
                            disabled={system}
                            onClick={() => setDeletePermission(permission)}
                            title="Delete"
                          >
                            <Trash2 className="size-4" aria-hidden />
                            <span className="sr-only">Delete {permission.name}</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </RuledTable>
          )}
        </TabsContent>
      </Tabs>

      <DetailSheet
        open={roleOpen}
        onOpenChange={setRoleOpen}
        size="lg"
        title={roleForm.id ? "Edit role" : "Create role"}
        description="Roles are scoped to organizations and identified by org:<name>."
        footer={
          <>
            <Button variant="outline" onClick={() => setRoleOpen(false)} disabled={roleSaving}>
              Cancel
            </Button>
            <Button onClick={() => void saveRole()} disabled={roleSaving || roleErrors.length > 0}>
              {roleSaving ? "Saving…" : roleForm.id ? "Save changes" : "Create role"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Role key" htmlFor="role-key" required error={roleForm.key !== "org:" && keyError ? keyError : null}>
              <Input
                id="role-key"
                value={roleForm.key}
                disabled={Boolean(roleForm.id)}
                onChange={(event) => setRoleForm((current) => ({ ...current, key: event.target.value }))}
                placeholder="org:auditor"
                className="font-data text-xs"
              />
            </Field>
            <Field label="Name" htmlFor="role-name" required>
              <Input
                id="role-name"
                value={roleForm.name}
                onChange={(event) => setRoleForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Auditor"
              />
            </Field>
          </div>
          <Field label="Description" htmlFor="role-description">
            <Textarea
              id="role-description"
              rows={2}
              value={roleForm.description}
              onChange={(event) => setRoleForm((current) => ({ ...current, description: event.target.value }))}
            />
          </Field>
          <CheckboxRow
            label="Creator eligible"
            description="Users may select this role when they create an organization."
            checked={roleForm.creatorEligible}
            onCheckedChange={(creatorEligible) => setRoleForm((current) => ({ ...current, creatorEligible }))}
          />
          <Field label="Permissions" description="Choose the permissions this role grants.">
            <div className="max-h-72 space-y-3 overflow-y-auto border border-border p-3">
              {Object.entries(roleGroups).map(([feature, entries]) => (
                <div key={feature} className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">{feature}</p>
                  {entries.map((permission) => (
                    <CheckboxRow
                      key={permission.key}
                      label={<code className="font-data text-xs">{permission.key}</code>}
                      description={permission.name}
                      checked={roleForm.permissionKeys.includes(permission.key)}
                      onCheckedChange={(checked) => togglePermission(permission.key, checked)}
                    />
                  ))}
                </div>
              ))}
              {Object.keys(roleGroups).length === 0 ? <p className="text-xs text-muted-foreground">No permissions available.</p> : null}
            </div>
          </Field>
          <ValidationSummary errors={roleErrors} title="Fix these before saving" />
        </div>
      </DetailSheet>

      <DetailSheet
        open={permissionOpen}
        onOpenChange={setPermissionOpen}
        title={permissionForm.id ? "Edit permission" : "Create permission"}
        description="Custom permissions use org:<feature>:<action>, for example org:reports:export."
        footer={
          <>
            <Button variant="outline" onClick={() => setPermissionOpen(false)} disabled={permissionSaving}>
              Cancel
            </Button>
            <Button onClick={() => void savePermission()} disabled={permissionSaving || permissionErrors.length > 0}>
              {permissionSaving ? "Saving…" : permissionForm.id ? "Save changes" : "Create permission"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field
            label="Permission key"
            htmlFor="permission-key"
            required
            error={permissionForm.key !== "org:" && permissionError ? permissionError : null}
          >
            <Input
              id="permission-key"
              value={permissionForm.key}
              disabled={Boolean(permissionForm.id)}
              onChange={(event) => setPermissionForm((current) => ({ ...current, key: event.target.value }))}
              placeholder="org:reports:export"
              className="font-data text-xs"
            />
          </Field>
          <Field label="Name" htmlFor="permission-name" required>
            <Input
              id="permission-name"
              value={permissionForm.name}
              onChange={(event) => setPermissionForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Export reports"
            />
          </Field>
          <Field label="Description" htmlFor="permission-description">
            <Textarea
              id="permission-description"
              rows={2}
              value={permissionForm.description}
              onChange={(event) => setPermissionForm((current) => ({ ...current, description: event.target.value }))}
            />
          </Field>
          <ValidationSummary errors={permissionErrors} title="Fix these before saving" />
        </div>
      </DetailSheet>

      <ConfirmDialog
        open={deleteRole !== null || deletePermission !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteRole(null);
            setDeletePermission(null);
          }
        }}
        title={deleteRole ? "Delete role?" : "Delete permission?"}
        description={
          <span>
            <code className="font-data">{deleteRole?.key ?? deletePermission?.key}</code> is removed. Memberships that use a deleted role must
            be reassigned.
          </span>
        }
        confirmLabel="Delete"
        destructive
        loading={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
