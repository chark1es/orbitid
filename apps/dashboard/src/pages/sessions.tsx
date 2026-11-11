import { useState } from "react";
import { Page as PageLayout } from "../components/shared/page";
import { Link } from "react-router-dom";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { LogOut, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import type { SessionJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatSessionExpiry } from "../lib/format";
import { buildListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { useUrlSyncedInput } from "../lib/hooks";
import { PageHeader } from "../components/shared/page-header";
import { DataTable, type DataTableColumn } from "../components/shared/data-table";
import { TablePagination } from "../components/shared/table-pagination";
import { EmptyState } from "../components/shared/empty-state";
import { StatusBadge } from "../components/shared/status-badge";
import { TimeAgo } from "../components/shared/time-ago";
import { ConfirmDialog } from "../components/shared/confirm-dialog";

const STATUSES = ["all", "active", "ended", "expired", "revoked", "removed", "pending"];

export default function SessionsPage() {
  const table = useTableState({ limit: 20, orderBy: "-created_at", filterKeys: ["status", "user_id"] });
  const queryClient = useQueryClient();
  const [userId, setUserId] = useUrlSyncedInput(table.filter("user_id"), (value) =>
    table.setFilter("user_id", value || null),
  400,
  );
  const [revoking, setRevoking] = useState<SessionJSON | null>(null);
  const [pending, setPending] = useState(false);

  const status = table.filter("status") || "all";
  const path = buildListPath("/sessions", {
    limit: table.limit,
    page: table.page,
    query: table.query,
    orderBy: table.orderBy,
    extra: { status: status === "all" ? undefined : status, user_id: table.filter("user_id") || undefined },
  });
  const sessions = useApi<{ data: SessionJSON[]; total_count: number }>(["sessions", path], path, {
    placeholderData: keepPreviousData,
  });
  const rows = sessions.data?.data ?? [];

  async function revoke() {
    if (!revoking) return;
    setPending(true);
    try {
      await api("POST", `/sessions/${revoking.id}/revoke`);
      toast.success("Session revoked");
      setRevoking(null);
      await Promise.all([sessions.refetch(), queryClient.invalidateQueries({ queryKey: ["stats"] })]);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<SessionJSON>[] = [
    {
      id: "status",
      header: "Status",
      cell: (session) => <StatusBadge status={session.status} />,
    },
    {
      id: "user",
      header: "User",
      cell: (session) =>
        session.public_user_data ? (
          <div className="min-w-0">
            <Link
              to={`/users/${session.public_user_data.user_id}`}
              className="block max-w-[30ch] truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {[session.public_user_data.first_name, session.public_user_data.last_name].filter(Boolean).join(" ") ||
                session.public_user_data.identifier}
            </Link>
            <span className="block max-w-[30ch] truncate text-[0.8125rem] text-muted-foreground">
              {session.public_user_data.identifier}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Unknown user</span>
        ),
    },
    {
      id: "created",
      header: "Started",
      sortKey: "created_at",
      cell: (session) => <TimeAgo value={session.created_at} className="font-data text-xs text-muted-foreground" />,
    },
    {
      id: "last_active",
      header: "Last active",
      sortKey: "last_active_at",
      cell: (session) => <TimeAgo value={session.last_active_at} className="font-data text-xs text-muted-foreground" />,
    },
    {
      id: "expires",
      header: "Expires",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (session) => (
        <span className="font-data text-xs text-muted-foreground">{formatSessionExpiry(session.expire_at)}</span>
      ),
    },
    {
      id: "device",
      header: "IP / browser",
      headerClassName: "hidden xl:table-cell",
      className: "hidden xl:table-cell",
      cell: (session) => (
        <div className="min-w-0 text-xs text-muted-foreground">
          <p className="truncate font-data" title={session.latest_activity?.ip_address ?? undefined}>{session.latest_activity?.ip_address || "No activity recorded"}</p>
          <p className="truncate" title={session.latest_activity?.browser_name ?? undefined}>{session.latest_activity?.browser_name || "Unknown browser"}</p>
        </div>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-24 text-right",
      cell: (session) => (
        <Button
          size="xs"
          variant="outline"
          disabled={session.status !== "active"}
          onClick={() => setRevoking(session)}
          aria-label={`Revoke session for ${session.public_user_data?.identifier ?? session.id}`}
        >
          <LogOut aria-hidden /> Revoke
        </Button>
      ),
    },
  ];

  return (
    <PageLayout>
      <PageHeader
        title="Sessions"
        description="Active and historical sessions across every client. Revoking one signs that client out."
      />

      <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
        <SearchInput
          value={userId}
          onChange={(event) => setUserId(event.target.value)}
          placeholder="Filter by user ID"
          aria-label="Filter sessions by user"
          className="min-w-56 max-w-md flex-1"
          inputClassName="font-data"
        />
        <Select value={status} onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}>
          <SelectTrigger className="h-[34px] w-[132px]" aria-label="Filter sessions by status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {value === "all" ? "Any status" : value.charAt(0).toUpperCase() + value.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {table.hasFilters ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setUserId("");
              table.reset();
            }}
          >
            Clear
          </Button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(session) => session.id}
        isLoading={sessions.isLoading}
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
        sortKey={table.sortKey}
        sortDescending={table.sortDescending}
        onSort={table.toggleSort}
        empty={
          <EmptyState
            icon={MonitorSmartphone}
            title={table.hasFilters ? "No sessions match these filters" : "No sessions yet"}
            description={
              table.hasFilters
                ? "Clear the status or user filter to see every session."
                : "Sessions appear after someone signs in through your app or the test site."
            }
          />
        }
      />

      <TablePagination
        page={table.page}
        limit={table.limit}
        total={sessions.data?.total_count ?? 0}
        onPageChange={table.setPage}
        onLimitChange={table.setLimit}
        disabled={sessions.isFetching}
      />

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke this session?"
        description="The client is signed out on its next request and refresh tokens issued for this session stop working."
        confirmLabel="Revoke session"
        destructive
        pending={pending}
        onConfirm={() => void revoke()}
      />
    </PageLayout>
  );
}
