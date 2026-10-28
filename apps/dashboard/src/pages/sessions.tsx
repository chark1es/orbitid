import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { LogOut, MonitorSmartphone, Search } from "lucide-react";
import { toast } from "sonner";
import type { SessionJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatDateTime } from "../lib/format";
import { buildListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { useDebounced } from "../lib/hooks";
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
  const [userId, setUserId] = useState(table.filter("user_id"));
  const debouncedUserId = useDebounced(userId.trim(), 400);
  const [revoking, setRevoking] = useState<SessionJSON | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (debouncedUserId !== table.filter("user_id")) table.setFilter("user_id", debouncedUserId || null);
  }, [debouncedUserId]);
  useEffect(() => setUserId(table.filter("user_id")), [table.searchParams]);

  const status = table.filter("status") || "all";
  const path = buildListPath("/sessions", {
    limit: table.limit,
    page: table.page,
    orderBy: table.orderBy,
    extra: {
      status: status === "all" ? undefined : status,
      user_id: table.filter("user_id") || undefined,
    },
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
      await Promise.all([
        sessions.refetch(),
        queryClient.invalidateQueries({ queryKey: ["stats"] }),
      ]);
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
            <Link to={`/users/${session.public_user_data.user_id}`} className="truncate text-sm font-medium hover:underline">
              {[session.public_user_data.first_name, session.public_user_data.last_name].filter(Boolean).join(" ") ||
                session.public_user_data.identifier}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{session.public_user_data.identifier}</p>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Unknown user</span>
        ),
    },
    {
      id: "created",
      header: "Started",
      sortKey: "created_at",
      cell: (session) => <TimeAgo value={session.created_at} className="text-sm" />,
    },
    {
      id: "last_active",
      header: "Last active",
      sortKey: "last_active_at",
      cell: (session) => <TimeAgo value={session.last_active_at} className="text-sm" />,
    },
    {
      id: "expires",
      header: "Expires",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (session) => <span className="text-xs text-muted-foreground">{formatDateTime(session.expire_at)}</span>,
    },
    {
      id: "device",
      header: "IP / browser",
      headerClassName: "hidden xl:table-cell",
      className: "hidden xl:table-cell",
      cell: (session) => (
        <div className="text-xs text-muted-foreground">
          <p className="font-mono">{session.latest_activity?.ip_address || "—"}</p>
          <p>{session.latest_activity?.browser_name || "Unknown browser"}</p>
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
        >
          <LogOut aria-hidden /> Revoke
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Sessions" description="Active and historical sessions across every client." />

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="Filter by user ID…"
            aria-label="Filter sessions by user"
            className="pl-8"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={status} onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}>
            <SelectTrigger className="h-9 w-[140px]" aria-label="Filter sessions by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  <span className="capitalize">{value}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
        empty={<EmptyState icon={MonitorSmartphone} title="No sessions" description="Sessions appear here after users sign in." />}
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
        description="The client is signed out immediately; refresh tokens issued for it stop working."
        confirmLabel="Revoke session"
        destructive
        pending={pending}
        onConfirm={() => void revoke()}
      />
    </>
  );
}
