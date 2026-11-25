import { useState } from "react";
import { Link } from "react-router-dom";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { KeyRound } from "lucide-react";
import { toast } from "sonner";
import type { OAuthApplicationAccessGrantJSON, UserJSON } from "@orbitid/shared";
import { api, apiAllPages, useApi } from "../../lib/api";
import { ownerLabel, useAllOAuthApplications, useAllOrganizations } from "../../lib/app-ownership";
import { errorMessage } from "../../lib/errors";
import { formatDate, userLabel } from "../../lib/format";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { Section } from "../shared/section";

/**
 * Organization-owned OAuth applications this user may use without being a member of the owning organization.
 * Members never need a grant; instance-wide applications are open to everyone.
 */
export function UserAppAccessTab({ user }: { user: UserJSON }) {
  const path = `/users/${user.id}/oauth_application_access_grants`;
  const grants = useApi<{ data: OAuthApplicationAccessGrantJSON[]; total_count: number }>(["user-app-access", user.id], path, {
    queryFn: ({ signal }) => apiAllPages<OAuthApplicationAccessGrantJSON>(path, { signal }),
  });
  const { applications, isLoading: applicationsLoading } = useAllOAuthApplications();
  const { organizations } = useAllOrganizations();
  const [choice, setChoice] = useState("");
  const [granting, setGranting] = useState(false);
  const [selected, setSelected] = useState<OAuthApplicationAccessGrantJSON | null>(null);
  const [revoking, setRevoking] = useState(false);

  const rows = grants.data?.data ?? [];
  const granted = new Set(rows.map((row) => row.application_id));
  const grantable = applications.filter((application) => application.organization_id && !granted.has(application.id));
  const applicationOf = (id: string) => applications.find((application) => application.id === id);
  const selectedApplication = selected ? applicationOf(selected.application_id) : undefined;

  async function grant() {
    if (!choice) return;
    setGranting(true);
    try {
      await api("POST", `/oauth_applications/${choice}/access_grants`, { user_id: user.id });
      toast.success(`Access granted to ${applicationOf(choice)?.name ?? "the application"}`);
      setChoice("");
      await grants.refetch();
    } catch (error) {
      toast.error("Could not grant access", { description: errorMessage(error) });
    } finally {
      setGranting(false);
    }
  }

  async function revoke(row: OAuthApplicationAccessGrantJSON) {
    setRevoking(true);
    try {
      await api("DELETE", `/oauth_applications/${row.application_id}/access_grants/${user.id}`);
      toast.success("Access revoked");
      setSelected(null);
      await grants.refetch();
    } catch (error) {
      toast.error("Could not revoke access", { description: errorMessage(error) });
    } finally {
      setRevoking(false);
    }
  }

  const columns: DataTableColumn<OAuthApplicationAccessGrantJSON>[] = [
    {
      id: "application",
      header: "Application",
      cell: (row) => {
        const application = applicationOf(row.application_id);
        return (
          <div className="min-w-0">
            <p className="truncate text-sm">{application?.name ?? "Deleted application"}</p>
            <code className="block max-w-[34ch] truncate font-data text-[0.6875rem] text-muted-foreground">
              {application?.client_id ?? row.application_id}
            </code>
          </div>
        );
      },
    },
    {
      id: "owner",
      header: "Owner",
      cell: (row) => {
        const organizationId = applicationOf(row.application_id)?.organization_id;
        return organizationId ? (
          <Link
            to={`/organizations/${organizationId}?tab=applications`}
            className="text-xs underline-offset-4 hover:underline"
          >
            {ownerLabel(organizationId, organizations)}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">Instance-wide (grant not needed)</span>
        );
      },
    },
    {
      id: "granted",
      header: "Granted",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (row) => <span className="font-data text-xs text-muted-foreground">{formatDate(row.created_at)}</span>,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10 text-right",
      headerClassName: "w-10",
      cell: (row) => (
        <Button size="xs" variant="outline" disabled={revoking} onClick={() => setSelected(row)}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <Section
      title="Application access"
      description="Organization applications this user can sign in to without being a member of the organization that owns them. Members of an organization can always use its applications."
      className="border-t-0 pt-0"
    >
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={choice} onValueChange={setChoice} disabled={grantable.length === 0}>
          <SelectTrigger className="w-full sm:max-w-sm" aria-label="Application to grant">
            <SelectValue
              placeholder={
                applicationsLoading
                  ? "Loading applications…"
                  : grantable.length === 0
                    ? "No organization applications to grant"
                    : "Choose an organization application"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {grantable.map((application) => (
              <SelectItem key={application.id} value={application.id}>
                {application.name} · {ownerLabel(application.organization_id, organizations)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => void grant()} disabled={!choice || granting}>
          {granting ? "Granting…" : "Grant access"}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.application_id}
        isLoading={grants.isLoading}
        error={grants.error}
        onRetry={() => void grants.refetch()}
        loadingRows={2}
        empty={
          <EmptyState
            icon={KeyRound}
            title="No cross-organization access"
            description="This user can use instance-wide applications and the applications of organizations they belong to. Grant access above to open one more organization application to them."
          />
        }
      />

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={`Revoke access to ${selectedApplication?.name ?? "this application"}?`}
        description={`Unless ${userLabel(user)} is a member of ${ownerLabel(selectedApplication?.organization_id, organizations)}, they are signed out of this application now: its codes and refresh tokens stop working at once, and issued access tokens are refused by userinfo and introspection.`}
        confirmLabel="Revoke access"
        destructive
        pending={revoking}
        onConfirm={() => {
          if (selected) void revoke(selected);
        }}
      />
    </Section>
  );
}
