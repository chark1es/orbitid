import type { RoleJSON } from "@orbitid/shared";
import {
  Button,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@orbitid/ui";
import { Pencil, Trash2 } from "lucide-react";
import { formatDate, isSystemRole } from "../_config/settings";
import { EmptyState, MetaChip, RuledTable, TableSkeleton } from "../_config/ui";
import type { RolesPermissionsController } from "./use-roles-permissions";
import { rolePermissionKeys, isSystemPermission } from "./model";

export function RolesPermissionsTabs({ ctl }: { ctl: RolesPermissionsController }) {
  const {
    setDeleteRole,
    setDeletePermission,
    scope,
    rolesQuery,
    permissionsQuery,
    roles,
    permissions,
    openEditRole,
    openEditPermission,
  } = ctl;

  return (
    <Tabs defaultValue="roles">
      <TabsList>
        <TabsTrigger value="roles">Roles ({roles.length})</TabsTrigger>
        <TabsTrigger value="permissions">Permissions ({permissions.length})</TabsTrigger>
      </TabsList>

      <TabsContent value="roles" className="mt-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-heading">Roles</h2>
          <p className="text-xs text-muted-foreground">{scope === "org" ? "Roles attach to organization memberships." : "Roles attach directly to users, with or without an organization."}</p>
        </div>
        {rolesQuery.isLoading ? (
          <TableSkeleton />
        ) : roles.length === 0 ? (
          <EmptyState compact title="No roles" description="The server seeds system roles at boot. Add a custom role to grant your own permissions." />
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
                          title="Delete">
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
          <h2 className="text-sm font-heading">Permissions</h2>
          <p className="text-xs text-muted-foreground">The Frontend API checks these keys and exposes them on session tokens.</p>
        </div>
        {permissionsQuery.isLoading ? (
          <TableSkeleton />
        ) : permissions.length === 0 ? (
          <EmptyState compact title="No permissions" description="The server seeds system permissions at boot." />
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
                          title="Delete">
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
  );
}
