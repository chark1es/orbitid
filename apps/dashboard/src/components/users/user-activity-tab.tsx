import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@orbitid/ui";
import { ScrollText } from "lucide-react";
import type { AuditLogJSON, UserJSON } from "@orbitid/shared";
import { useApi } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { useTableState } from "../../lib/use-table-state";
import { buildListPath } from "../../lib/query";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { TablePagination } from "../shared/table-pagination";
import { EmptyState } from "../shared/empty-state";

export function UserActivityTab({ user }: { user: UserJSON }) {
  const table = useTableState({ limit: 10, orderBy: "-created_at" });
  const path = buildListPath("/audit_logs", {
    limit: table.limit,
    page: table.page,
    orderBy: table.orderBy,
    extra: { target_id: user.id },
  });
  const logs = useApi<{ data: AuditLogJSON[]; total_count: number }>(["user-activity", path], path);

  const columns: DataTableColumn<AuditLogJSON>[] = [
    {
      id: "action",
      header: "Action",
      cell: (log) => <code className="text-xs font-medium">{log.action}</code>,
    },
    {
      id: "target",
      header: "Target",
      cell: (log) => (
        <span className="text-xs text-muted-foreground">
          {log.target_type ?? "—"}
          {log.target_id ? ` · ${log.target_id.slice(0, 20)}` : ""}
        </span>
      ),
    },
    {
      id: "actor",
      header: "Actor",
      cell: (log) => <span className="text-xs text-muted-foreground">{log.actor ?? "system"}</span>,
    },
    {
      id: "metadata",
      header: "Metadata",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (log) => (
        <code className="line-clamp-1 max-w-64 text-xs text-muted-foreground">
          {Object.keys(log.metadata).length ? JSON.stringify(log.metadata) : "—"}
        </code>
      ),
    },
    {
      id: "created",
      header: "When",
      cell: (log) => <span className="whitespace-nowrap text-xs">{formatDateTime(log.created_at)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle>Activity</CardTitle>
          <CardDescription>Audit log entries targeting this user.</CardDescription>
        </div>
        <Badge variant="outline">target_id: {user.id}</Badge>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataTable
          columns={columns}
          rows={logs.data?.data ?? []}
          rowKey={(log) => log.id}
          isLoading={logs.isLoading}
          error={logs.error}
          onRetry={() => void logs.refetch()}
          loadingRows={4}
          empty={<EmptyState icon={ScrollText} title="No activity" description="Backend mutations targeting this user appear here." />}
        />
        <TablePagination
          page={table.page}
          limit={table.limit}
          total={logs.data?.total_count ?? 0}
          onPageChange={table.setPage}
          onLimitChange={table.setLimit}
          disabled={logs.isFetching}
        />
      </CardContent>
    </Card>
  );
}
