import { Button } from "@orbitid/ui";
import { Page as PageLayout } from "../components/shared/page";
import { Plus } from "lucide-react";
import { errorMessage } from "./_config/settings";
import { ErrorAlert, Field, PageHeader } from "./_config/ui";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { useRolesPermissions } from "./_roles-permissions/use-roles-permissions";
import { RolesPermissionsTabs } from "./_roles-permissions/roles-permissions-tabs";
import { RoleSheet, PermissionSheet } from "./_roles-permissions/role-permission-sheets";

export default function Page() {
  const ctl = useRolesPermissions();
  const {
    setScope,
    setRoleOpen,
    setPermissionOpen,
    deleteRole,
    setDeleteRole,
    deletePermission,
    setDeletePermission,
    deleting,
    showOrganizations,
    scope,
    rolesQuery,
    permissionsQuery,
    openCreateRole,
    openCreatePermission,
    confirmDelete,
  } = ctl;

  return (
    <PageLayout>
      <PageHeader
        title="Roles & permissions"
        description="Assign instance roles to users or organization roles to memberships. System entries are read-only."
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

      <Field label="Role scope" htmlFor="role-scope">
        <select id="role-scope" value={scope} onChange={(event) => { setScope(event.target.value as "app" | "org"); setRoleOpen(false); setPermissionOpen(false); }} className="h-[34px] rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <option value="app">Instance</option>
          {showOrganizations ? <option value="org">Organization</option> : null}
        </select>
      </Field>

      {rolesQuery.error ? <ErrorAlert error={errorMessage(rolesQuery.error)} onRetry={() => void rolesQuery.refetch()} /> : null}
      {permissionsQuery.error ? <ErrorAlert error={errorMessage(permissionsQuery.error)} onRetry={() => void permissionsQuery.refetch()} /> : null}

      <RolesPermissionsTabs ctl={ctl} />

      <RoleSheet ctl={ctl} />

      <PermissionSheet ctl={ctl} />

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
            <code className="font-data">{deleteRole?.key ?? deletePermission?.key}</code> is removed. Remove its assignments before deleting a role.
          </span>
        }
        confirmLabel="Delete"
        destructive
        pending={deleting}
        onConfirm={() => void confirmDelete()}
      />
    </PageLayout>
  );
}
