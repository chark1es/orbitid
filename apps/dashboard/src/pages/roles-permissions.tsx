import { useState } from "react";
import type { PaginatedList, PermissionJSON, RoleJSON } from "@orbitid/shared";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
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
import { Pencil, Plus, Shield, Trash2 } from "lucide-react";
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
  EmptyState,
  ErrorAlert,
  Field,
  LoadingPage,
  PageHeader,
  SectionCard,
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
  const [roleDialog, setRoleDialog] = useState(false);
  const [roleForm, setRoleForm] = useState<RoleForm>(EMPTY_ROLE);
  const [roleSaving, setRoleSaving] = useState(false);
  const [permissionDialog, setPermissionDialog] = useState(false);
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
    setRoleDialog(true);
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
    setRoleDialog(true);
  };
  const openCreatePermission = () => {
    setPermissionForm(EMPTY_PERMISSION);
    setPermissionDialog(true);
  };
  const openEditPermission = (permission: PermissionJSON) => {
    setPermissionForm({ id: permission.id, key: permission.key, name: permission.name, description: permission.description ?? "" });
    setPermissionDialog(true);
  };

  const roleErrors: string[] = [];
  const keyError = roleKeyError(roleForm.key);
  if (keyError) roleErrors.push(keyError);
  if (!roleForm.name.trim()) roleErrors.push("Role name is required.");
  if (roles.some((role) => role.key === roleForm.key.trim() && role.id !== roleForm.id)) roleErrors.push("A role with this key already exists.");

  const permissionErrors: string[] = [];
  const permissionError = permissionKeyError(permissionForm.key);
  if (permissionError) permissionErrors.push(permissionError);
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
      setRoleDialog(false);
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
      setPermissionDialog(false);
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
        description="Organization RBAC. System roles and permissions are read-only; custom entries use `org:<name>` and `org:<feature>:<action>`."
        actions={
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={openCreatePermission}>
              <Plus className="size-4" /> Permission
            </Button>
            <Button size="sm" onClick={openCreateRole}>
              <Plus className="size-4" /> Role
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

        <TabsContent value="roles" className="mt-4">
          <SectionCard title="Roles" description="Roles bundle permissions and are assigned to organization memberships.">
            {rolesQuery.isLoading ? (
              <LoadingPage rows={1} />
            ) : roles.length === 0 ? (
              <EmptyState title="No roles" description="System roles are seeded at boot; add a custom role to get started." />
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Role</TableHead>
                      <TableHead>Permissions</TableHead>
                      <TableHead>Creator eligible</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {roles.map((role) => {
                      const system = isSystemRole(role as RoleJSON & { is_system?: boolean });
                      return (
                        <TableRow key={role.id}>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <Shield className="size-4 text-muted-foreground" />
                              <div>
                                <p className="font-medium">{role.name}</p>
                                <code className="text-xs text-muted-foreground">{role.key}</code>
                              </div>
                              {system ? <Badge variant="secondary">System</Badge> : null}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{rolePermissionKeys(role).length}</Badge>
                          </TableCell>
                          <TableCell>{role.is_creator_eligible ? <Badge variant="outline">Yes</Badge> : "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatDate(role.updated_at)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="icon-sm" disabled={system} onClick={() => openEditRole(role)} title="Edit">
                                <Pencil className="size-4" />
                                <span className="sr-only">Edit</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-destructive"
                                disabled={system}
                                onClick={() => setDeleteRole(role)}
                                title="Delete"
                              >
                                <Trash2 className="size-4" />
                                <span className="sr-only">Delete</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="permissions" className="mt-4">
          <SectionCard title="Permissions" description="Permissions are checked by the Frontend API and exposed on session tokens.">
            {permissionsQuery.isLoading ? (
              <LoadingPage rows={1} />
            ) : permissions.length === 0 ? (
              <EmptyState title="No permissions" description="System permissions are seeded at boot." />
            ) : (
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Permission</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="w-24" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {permissions.map((permission) => {
                      const system = isSystemPermission(permission);
                      return (
                        <TableRow key={permission.id}>
                          <TableCell>
                            <p className="font-medium">{permission.name}</p>
                            <code className="text-xs text-muted-foreground">{permission.key}</code>
                          </TableCell>
                          <TableCell>
                            <Badge variant={system ? "secondary" : "outline"}>{system ? "System" : "Custom"}</Badge>
                          </TableCell>
                          <TableCell className="max-w-md text-xs text-muted-foreground">{permission.description || "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatDate(permission.updated_at)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="icon-sm" disabled={system} onClick={() => openEditPermission(permission)} title="Edit">
                                <Pencil className="size-4" />
                                <span className="sr-only">Edit</span>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-destructive"
                                disabled={system}
                                onClick={() => setDeletePermission(permission)}
                                title="Delete"
                              >
                                <Trash2 className="size-4" />
                                <span className="sr-only">Delete</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>

      <Dialog open={roleDialog} onOpenChange={setRoleDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{roleForm.id ? "Edit role" : "Create role"}</DialogTitle>
            <DialogDescription>{"Roles are scoped to organizations and identified by `org:<name>`."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Role key" htmlFor="role-key" required error={roleForm.key !== "org:" && keyError ? keyError : null}>
                <Input
                  id="role-key"
                  value={roleForm.key}
                  disabled={Boolean(roleForm.id)}
                  onChange={(event) => setRoleForm((current) => ({ ...current, key: event.target.value }))}
                  placeholder="org:billing"
                  className="font-mono"
                />
              </Field>
              <Field label="Name" htmlFor="role-name" required>
                <Input id="role-name" value={roleForm.name} onChange={(event) => setRoleForm((current) => ({ ...current, name: event.target.value }))} placeholder="Billing" />
              </Field>
            </div>
            <Field label="Description" htmlFor="role-description">
              <Textarea id="role-description" rows={2} value={roleForm.description} onChange={(event) => setRoleForm((current) => ({ ...current, description: event.target.value }))} />
            </Field>
            <CheckboxRow
              label="Creator eligible"
              description="Users may select this role when creating an organization."
              checked={roleForm.creatorEligible}
              onCheckedChange={(creatorEligible) => setRoleForm((current) => ({ ...current, creatorEligible }))}
            />
            <Field label="Permissions" description="Choose the permissions granted by this role.">
              <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border p-3">
                {Object.entries(roleGroups).map(([feature, entries]) => (
                  <div key={feature} className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{feature}</p>
                    {entries.map((permission) => (
                      <CheckboxRow
                        key={permission.key}
                        label={<code className="text-xs">{permission.key}</code>}
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
            {roleErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {roleErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialog(false)} disabled={roleSaving}>
              Cancel
            </Button>
            <Button onClick={() => void saveRole()} disabled={roleSaving || roleErrors.length > 0}>
              {roleSaving ? "Saving…" : roleForm.id ? "Save changes" : "Create role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={permissionDialog} onOpenChange={setPermissionDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{permissionForm.id ? "Edit permission" : "Create permission"}</DialogTitle>
            <DialogDescription>{"Custom permissions use `org:<feature>:<action>`, for example `org:billing:manage`."}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
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
                placeholder="org:billing:manage"
                className="font-mono"
              />
            </Field>
            <Field label="Name" htmlFor="permission-name" required>
              <Input id="permission-name" value={permissionForm.name} onChange={(event) => setPermissionForm((current) => ({ ...current, name: event.target.value }))} placeholder="Manage billing" />
            </Field>
            <Field label="Description" htmlFor="permission-description">
              <Textarea
                id="permission-description"
                rows={2}
                value={permissionForm.description}
                onChange={(event) => setPermissionForm((current) => ({ ...current, description: event.target.value }))}
              />
            </Field>
            {permissionErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {permissionErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPermissionDialog(false)} disabled={permissionSaving}>
              Cancel
            </Button>
            <Button onClick={() => void savePermission()} disabled={permissionSaving || permissionErrors.length > 0}>
              {permissionSaving ? "Saving…" : permissionForm.id ? "Save changes" : "Create permission"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <code>{deleteRole?.key ?? deletePermission?.key}</code> will be removed. Memberships using a deleted role must be reassigned.
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
