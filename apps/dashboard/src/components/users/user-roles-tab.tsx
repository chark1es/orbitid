import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@orbitid/ui";
import type { PaginatedList, RoleJSON, UserJSON, UserRolesJSON } from "@orbitid/shared";
import { toast } from "sonner";
import { useApi, useApiMutation } from "../../lib/api";
import { unwrapList } from "../../pages/_config/data";
import { CheckboxRow, ErrorAlert, MetaChip, TableSkeleton } from "../../pages/_config/ui";
import { errorMessage } from "../../lib/errors";
import { Section } from "../shared/section";

const sameSet = (a: string[], b: string[]) => [...a].sort().join("\n") === [...b].sort().join("\n");
// Mirrors the backend's reserved instance prefix (`RESERVED_INSTANCE_KEY_PREFIX`, `app:sys_`): the seeded console
// grants. Copy only; the server decides what a system grant is.
const isSystemGrant = (key: string) => key.startsWith("app:sys_");

/**
 * The default this user actually inherits: the configured default only when the user holds it. A default that no
 * longer exists, or one the resolver refuses, grants nothing, so the tab treats it as no default.
 */
const inheritedDefault = (assignment: UserRolesJSON): string | null =>
  assignment.default_role && assignment.roles.includes(assignment.default_role) ? assignment.default_role : null;

/** Where the effective roles come from, in words. */
function sourceText(assignment: UserRolesJSON, guest: boolean): string {
  const system = assignment.roles.filter(isSystemGrant);
  const custom = assignment.roles.filter((key) => !isSystemGrant(key));
  const consoleNote = system.length > 0
    ? " Saving replaces every role, so unticking a system role removes console access; resetting keeps it."
    : "";
  if (assignment.source === "assigned") {
    if (custom.length === 0 && system.length === 0) {
      return "Assigned: this user explicitly has no instance roles, so the default role does not apply.";
    }
    if (custom.length === 0) {
      return `Assigned: only a system role (console access), no custom roles, so the default role does not apply.${consoleNote}`;
    }
    return `Assigned by an operator. The default role does not apply.${consoleNote}`;
  }
  if (guest) return "Guests don't inherit the default role. Saving makes these roles an explicit assignment.";
  return inheritedDefault(assignment)
    ? `Follows the default role.${consoleNote} Saving makes these roles an explicit assignment; this user will stop following the default.`
    : `No custom roles are assigned and no default role applies.${consoleNote} Saving makes these roles an explicit assignment.`;
}

/** Chip text for the role source. Guests report `default` but hold nothing from it. */
function sourceLabel(assignment: UserRolesJSON, guest: boolean): string {
  if (assignment.source === "assigned") return "Assigned";
  if (guest) return "Guest: no default";
  return inheritedDefault(assignment) ? "Inherited from default" : "No default set";
}

/** Instance roles are assigned through an operator-only endpoint, never through editable metadata. */
export function UserRolesTab({ user }: { user: UserJSON }) {
  const query = useApi<PaginatedList<RoleJSON>>(["roles", "instance"], "/roles?limit=100&query=app%3A");
  const assignmentQuery = useApi<UserRolesJSON>(["user", user.id, "roles"], `/users/${user.id}/roles`);
  const roles = unwrapList<RoleJSON>(query.data).filter((role) => role.key.startsWith("app:"));
  const assignment = assignmentQuery.data;
  const defaultRole = assignment?.default_role ?? null;
  const effective = assignment?.roles ?? user.roles ?? [];
  const [selected, setSelected] = useState<string[]>(effective);
  const effectiveKey = effective.join("\n");
  // Keyed by value: `effective` is a new array on every render.
  useEffect(() => { setSelected(effectiveKey ? effectiveKey.split("\n") : []); }, [user.id, effectiveKey]);
  const invalidate = [["user", user.id], ["users"]];
  const save = useApiMutation<{ roles: string[] }>("PUT", `/users/${user.id}/roles`, {
    invalidate,
    onSuccess: () => toast.success("Roles updated"),
  });
  // The toast reads the server's answer, so it is right even if the default changed while the tab was open.
  const reset = useApiMutation<undefined, UserRolesJSON>("DELETE", `/users/${user.id}/roles`, {
    invalidate,
    onSuccess: (result) => toast.success(inheritedDefault(result) ? "Roles reset to the default" : "Custom roles cleared"),
  });
  const pending = save.isPending || reset.isPending;
  const dirty = !sameSet(selected, effective);
  const guest = user.is_anonymous === true;
  const inherited = assignment?.source === "default";
  const loading = query.isLoading || assignmentQuery.isLoading;
  const error = query.error ?? assignmentQuery.error;
  return <Section title="Instance roles" className="border-t-0 pt-0"
    description="These permissions apply with or without an organization. Organization roles are managed on memberships."
    actions={<Button asChild variant="outline" size="sm"><Link to="/roles">Manage roles</Link></Button>}>
    {loading ? <TableSkeleton /> : error ? <ErrorAlert error={errorMessage(error)} onRetry={() => { void query.refetch(); void assignmentQuery.refetch(); }} /> : <div className="space-y-4">
      {assignment ? <div className="flex flex-wrap items-center gap-2 text-sm">
        <MetaChip>{sourceLabel(assignment, guest)}</MetaChip>
        <span className="text-muted-foreground">{sourceText(assignment, guest)}</span>
      </div> : null}
      {roles.length === 0 ? <p className="text-sm text-muted-foreground">Create an instance role before assigning permissions to this user.</p> : roles.map((role) => {
        const viaDefault = inherited && !guest && role.key === defaultRole && effective.includes(role.key);
        return <CheckboxRow key={role.id} label={viaDefault ? `${role.name} (default)` : role.name} description={role.key} disabled={pending} checked={selected.includes(role.key)}
          onCheckedChange={(checked) => setSelected((current) => checked ? [...current, role.key] : current.filter((key) => key !== role.key))} />;
      })}
      {save.error ? <ErrorAlert error={errorMessage(save.error)} /> : null}
      {reset.error ? <ErrorAlert error={errorMessage(reset.error)} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!dirty || pending} onClick={() => save.mutate({ roles: selected })}>{save.isPending ? "Saving…" : "Save roles"}</Button>
        {assignment && !inherited ? <Button variant="outline" disabled={pending} onClick={() => reset.mutate(undefined)}>
          {reset.isPending ? "Resetting…" : defaultRole ? `Reset to default (${defaultRole})` : "Clear custom roles"}
        </Button> : null}
      </div>
    </div>}
  </Section>;
}
