import { Button, Input, Textarea } from "@orbitid/ui";
import { CheckboxRow, DetailSheet, Field, ValidationSummary } from "../_config/ui";
import type { RolesPermissionsController } from "./use-roles-permissions";

export function RoleSheet({ ctl }: { ctl: RolesPermissionsController }) {
  const {
    roleOpen,
    setRoleOpen,
    roleForm,
    setRoleForm,
    roleSaving,
    scope,
    prefix,
    roleGroups,
    roleErrors,
    keyError,
    saveRole,
    togglePermission,
  } = ctl;

  return (
    <DetailSheet
      open={roleOpen}
      onOpenChange={setRoleOpen}
      size="lg"
      title={roleForm.id ? "Edit role" : "Create role"}
      description={scope === "org" ? "Organization roles use org:<name>." : "Instance roles use app:<name> and are assigned on a user’s Roles tab."}
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
              placeholder={`${prefix}auditor`}
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
        {scope === "org" ? <CheckboxRow
          label="Creator eligible"
          description="Users may select this role when they create an organization."
          checked={roleForm.creatorEligible}
          onCheckedChange={(creatorEligible) => setRoleForm((current) => ({ ...current, creatorEligible }))}
        /> : null}
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
  );
}

export function PermissionSheet({ ctl }: { ctl: RolesPermissionsController }) {
  const {
    permissionOpen,
    setPermissionOpen,
    permissionForm,
    setPermissionForm,
    permissionSaving,
    prefix,
    permissionErrors,
    permissionError,
    savePermission,
  } = ctl;

  return (
    <DetailSheet
      open={permissionOpen}
      onOpenChange={setPermissionOpen}
      title={permissionForm.id ? "Edit permission" : "Create permission"}
      description={`Custom permissions use ${prefix}<feature>:<action>, for example ${prefix}reports:export.`}
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
            placeholder={`${prefix}reports:export`}
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
  );
}
