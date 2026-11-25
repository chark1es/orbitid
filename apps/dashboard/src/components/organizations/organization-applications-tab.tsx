import { Link } from "react-router-dom";
import { Button } from "@orbitid/ui";
import { AppWindow } from "lucide-react";
import type { OAuthApplicationJSON, OrganizationJSON } from "@orbitid/shared";
import { apiAllPages, useApi } from "../../lib/api";
import { formatDate } from "../../lib/format";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { Section } from "../shared/section";

/** The OAuth applications this organization owns. Ownership is changed from the OAuth applications page. */
export function OrganizationApplicationsTab({ org }: { org: OrganizationJSON }) {
  const path = `/oauth_applications?organization_id=${encodeURIComponent(org.id)}`;
  const query = useApi<{ data: OAuthApplicationJSON[]; total_count: number }>(["oauth_applications", "owner", org.id], path, {
    queryFn: ({ signal }) => apiAllPages<OAuthApplicationJSON>(path, { signal }),
  });
  const rows = query.data?.data ?? [];

  const columns: DataTableColumn<OAuthApplicationJSON>[] = [
    {
      id: "name",
      header: "Application",
      cell: (application) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{application.name}</p>
          <code className="block max-w-[34ch] truncate font-data text-[0.6875rem] text-muted-foreground">
            {application.client_id}
          </code>
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (application) => (
        <span className="text-xs text-muted-foreground">{application.public ? "Public" : "Confidential"}</span>
      ),
    },
    {
      id: "created",
      header: "Created",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (application) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(application.created_at)}</span>
      ),
    },
  ];

  return (
    <Section
      title="Applications"
      description="OAuth applications this organization owns. Its members can sign in to them; anyone else needs access granted from their user page."
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link to="/oauth-apps">Manage OAuth applications</Link>
        </Button>
      }
      className="border-t-0 pt-0"
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(application) => application.id}
        isLoading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        loadingRows={2}
        empty={
          <EmptyState
            icon={AppWindow}
            title="No applications"
            description="Choose this organization as an application's owner on the OAuth applications page to limit it to these members."
          />
        }
      />
    </Section>
  );
}
