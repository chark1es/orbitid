import { useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { roleLabel, useOrganizationRoles } from "../../lib/organizations";

export function OrganizationRoleSelect({
  orgId,
  userId,
  role,
  onChanged,
}: {
  orgId: string;
  userId: string;
  role: string;
  onChanged: () => void;
}) {
  const { roles } = useOrganizationRoles(orgId);
  const [pending, setPending] = useState(false);

  async function change(nextRole: string) {
    if (nextRole === role) return;
    setPending(true);
    try {
      await api("PATCH", `/organizations/${orgId}/memberships/${userId}`, { role: nextRole });
      toast.success("Role updated");
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Select value={role} onValueChange={(value) => void change(value)} disabled={pending}>
      <SelectTrigger className="h-8 w-[150px]" aria-label="Membership role">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roles.map((option) => (
          <SelectItem key={option.key} value={option.key}>
            {option.name || roleLabel(option.key)}
          </SelectItem>
        ))}
        {!roles.some((option) => option.key === role) ? <SelectItem value={role}>{roleLabel(role)}</SelectItem> : null}
      </SelectContent>
    </Select>
  );
}
