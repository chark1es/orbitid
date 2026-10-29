import type { PaginatedList, RoleJSON } from "@orbitid/shared";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { useApi } from "../lib/api";
import { unwrapList } from "./_config/data";
import {
  ErrorAlert,
  Field,
  LoadingPage,
  MetaChip,
  PageHeader,
  SaveBar,
  SettingsSection,
  SwitchRow,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

const FALLBACK_ROLES = [
  { key: "org:admin", name: "Admin" },
  { key: "org:member", name: "Member" },
];

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const rolesQuery = useApi<PaginatedList<RoleJSON>>(["roles", "roles-for-organizations"], "/roles?limit=100");
  const roles = unwrapList<RoleJSON>(rolesQuery.data).filter((role) => role.key.startsWith("org:"));
  const roleOptions = roles.length > 0 ? roles.map((role) => ({ key: role.key, name: role.name })) : FALLBACK_ROLES;

  if (editor.isLoading) return <LoadingPage rows={4} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Organizations" description="Organization creation, membership limits, domains, and default roles." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const orgs = settings.organizations;
  const errors: string[] = [];
  if (orgs.maxAllowedMemberships < 1) errors.push("Maximum memberships must be at least 1.");
  if (orgs.maxCreatedOrganizationsPerUser !== null && orgs.maxCreatedOrganizationsPerUser < 0)
    errors.push("Per-user organization limit cannot be negative.");
  if (!orgs.creatorRole) errors.push("Choose a creator role.");
  if (!orgs.defaultRole) errors.push("Choose a default member role.");
  if (rolesQuery.error && orgs.enabled) errors.push("Custom roles did not load, so only the system roles are shown.");

  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const roleSelect = (id: string, value: string, onChange: (role: string) => void, label: string, disabled: boolean) => {
    const options = roleOptions.some((role) => role.key === value) ? roleOptions : [...roleOptions, { key: value, name: value }];
    return (
      <Field label={label} htmlFor={id}>
        <Select value={value} onValueChange={onChange} disabled={disabled}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Select a role" />
          </SelectTrigger>
          <SelectContent>
            {options.map((role) => (
              <SelectItem key={role.key} value={role.key}>
                {role.name} <span className="text-muted-foreground">({role.key})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="Organizations group users, roles, domains, and invitations. These settings apply to the whole instance."
        badge={<MetaChip>{orgs.enabled ? "Enabled" : "Disabled"}</MetaChip>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection title="Organization features" description="Turn organizations on before configuring membership or domain behavior.">
        <SwitchRow
          label="Enable organizations"
          description="Turns on organizations, memberships, invitations, and organization-scoped sessions."
          checked={orgs.enabled}
          onCheckedChange={(enabled) => editor.patch({ organizations: { enabled } })}
        />
        <div className="space-y-4">
          <SwitchRow
            label="Allow users to create organizations"
            description="Users can create their own organizations from the organization switcher."
            checked={orgs.creationEnabled}
            disabled={!orgs.enabled}
            onCheckedChange={(creationEnabled) =>
              editor.patch({ organizations: { creationEnabled }, userSettings: { createOrganizationEnabled: creationEnabled } })
            }
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Maximum memberships per user" htmlFor="org-max-memberships" description="Organizations a user can belong to at once.">
              <Input
                id="org-max-memberships"
                type="number"
                min={1}
                disabled={!orgs.enabled}
                value={orgs.maxAllowedMemberships}
                onChange={(event) => editor.patch({ organizations: { maxAllowedMemberships: number(event.target.value) } })}
              />
            </Field>
            <Field label="Maximum created organizations per user" htmlFor="org-max-created" description="Leave blank for no limit.">
              <Input
                id="org-max-created"
                type="number"
                min={0}
                disabled={!orgs.enabled}
                value={orgs.maxCreatedOrganizationsPerUser ?? ""}
                onChange={(event) =>
                  editor.patch({
                    organizations: { maxCreatedOrganizationsPerUser: event.target.value === "" ? null : number(event.target.value) },
                  })
                }
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {roleSelect("org-creator-role", orgs.creatorRole, (creatorRole) => editor.patch({ organizations: { creatorRole } }), "Creator role", !orgs.enabled)}
            {roleSelect("org-default-role", orgs.defaultRole, (defaultRole) => editor.patch({ organizations: { defaultRole } }), "Default member role", !orgs.enabled)}
          </div>
          <SwitchRow
            label="Allow organization admins to delete the organization"
            description="Admins can permanently delete their organization and its memberships."
            checked={orgs.adminDeleteEnabled}
            disabled={!orgs.enabled}
            onCheckedChange={(adminDeleteEnabled) => editor.patch({ organizations: { adminDeleteEnabled } })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Slugs, domains, and discovery" description="How organizations are addressed and found.">
        <SwitchRow
          label="Enable organization slugs"
          description="Organizations get a unique, URL-safe slug such as /acme."
          checked={orgs.slugEnabled}
          disabled={!orgs.enabled}
          onCheckedChange={(slugEnabled) => editor.patch({ organizations: { slugEnabled } })}
        />
        <SwitchRow
          label="Enable verified domains"
          description="Organizations can claim domains, verify ownership, and enroll users by email domain."
          checked={orgs.domainsEnabled}
          disabled={!orgs.enabled}
          onCheckedChange={(domainsEnabled) => editor.patch({ organizations: { domainsEnabled } })}
        />
        <SwitchRow
          label="Enable membership requests"
          description="Users can request to join an organization that allows requests."
          checked={orgs.membershipRequestsEnabled}
          disabled={!orgs.enabled}
          onCheckedChange={(membershipRequestsEnabled) => editor.patch({ organizations: { membershipRequestsEnabled } })}
        />
        <SwitchRow
          label="Force organization selection"
          description="Require an active organization on every session before organization-scoped features work."
          checked={orgs.forceOrganizationSelection}
          disabled={!orgs.enabled}
          onCheckedChange={(forceOrganizationSelection) => editor.patch({ organizations: { forceOrganizationSelection } })}
        />
      </SettingsSection>

      <SettingsSection title="User actions" description="What signed-in users can do without an administrator.">
        <SwitchRow
          label="Allow users to delete their own account"
          description="Shows a danger zone action in the user profile."
          checked={settings.userSettings.deleteSelfEnabled}
          onCheckedChange={(deleteSelfEnabled) => editor.patch({ userSettings: { deleteSelfEnabled } })}
        />
        <SwitchRow
          label="Allow profile image uploads"
          checked={settings.userSettings.allowProfileImageUpload}
          onCheckedChange={(allowProfileImageUpload) => editor.patch({ userSettings: { allowProfileImageUpload } })}
        />
      </SettingsSection>

      <SaveBar
        dirty={editor.dirty}
        saving={editor.saving}
        disabled={errors.length > 0}
        errors={errors}
        error={editor.saveError}
        onSave={editor.save}
        onDiscard={editor.reset}
      />
    </div>
  );
}
