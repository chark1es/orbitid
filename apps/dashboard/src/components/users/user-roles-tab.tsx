import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@orbitid/ui";
import type { PaginatedList, RoleJSON, UserJSON } from "@orbitid/shared";
import { toast } from "sonner";
import { useApi, useApiMutation } from "../../lib/api";
import { unwrapList } from "../../pages/_config/data";
import { CheckboxRow, ErrorAlert, TableSkeleton } from "../../pages/_config/ui";
import { errorMessage } from "../../lib/errors";
import { Section } from "../shared/section";

/** Instance roles are assigned through an operator-only endpoint, never through editable metadata. */
export function UserRolesTab({ user }: { user: UserJSON }) {
  const query = useApi<PaginatedList<RoleJSON>>(["roles", "instance"], "/roles?limit=100&query=app%3A");
  const roles = unwrapList<RoleJSON>(query.data).filter((role) => role.key.startsWith("app:"));
  const [selected, setSelected] = useState<string[]>(user.roles ?? []);
  useEffect(() => { setSelected(user.roles ?? []); }, [user.id, user.roles]);
  const save = useApiMutation<{ roles: string[] }>("PUT", `/users/${user.id}/roles`, {
    invalidate: [["user", user.id], ["users"]],
    onSuccess: () => toast.success("Roles updated"),
  });
  const dirty = [...selected].sort().join("\n") !== [...(user.roles ?? [])].sort().join("\n");
  return <Section title="Instance roles" className="border-t-0 pt-0"
    description="These permissions apply with or without an organization. Organization roles are managed on memberships."
    actions={<Button asChild variant="outline" size="sm"><Link to="/roles">Manage roles</Link></Button>}>
    {query.isLoading ? <TableSkeleton /> : query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : <div className="space-y-4">
      {roles.length === 0 ? <p className="text-sm text-muted-foreground">Create an instance role before assigning permissions to this user.</p> : roles.map((role) => <CheckboxRow key={role.id} label={role.name} description={role.key} disabled={save.isPending} checked={selected.includes(role.key)}
        onCheckedChange={(checked) => setSelected((current) => checked ? [...current, role.key] : current.filter((key) => key !== role.key))} />)}
      {save.error ? <ErrorAlert error={errorMessage(save.error)} /> : null}
      <Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ roles: selected })}>{save.isPending ? "Saving…" : "Save roles"}</Button>
    </div>}
  </Section>;
}
