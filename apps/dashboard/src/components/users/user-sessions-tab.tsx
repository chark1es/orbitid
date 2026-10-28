import { useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import type { SessionJSON, UserJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDateTime } from "../../lib/format";
import { buildListPath } from "../../lib/query";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { TablePagination } from "../shared/table-pagination";
import { StatusBadge } from "../shared/status-badge";
import { TimeAgo } from "../shared/time-ago";
import { EmptyState } from "../shared/empty-state";
import { ConfirmDialog } from "../shared/confirm-dialog";

const STATUSES = ["all", "active", "ended", "expired", "revoked", "removed", "abandoned", "replaced", "pending"];

export function UserSessionsTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [status, setStatus] = useState("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);

  const path = buildListPath("/sessions", {
    limit,
    page,
    orderBy: "-created_at",
    extra: { user_id: user.id, status: status === "all" ? undefined : status },
  });
  const sessions = useApi<{ data: SessionJSON[]; total_count: number }>(["user-sessions", path], path);
  const rows = sessions.data?.data ?? [];

  async function revoke(session: SessionJSON) {
    setPendingId(session.id);
    try {
      await api("POST", `/sessions/${session.id}/revoke`);
      toast.success("Session revoked");
      await sessions.refetch();
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function revokeAll() {
    setPendingId("all");
    try {
      await Promise.all(rows.filter((session) => session.status === "active").map((session) => api("POST", `/sessions/${session.id}/revoke`)));
      toast.success("Active sessions on this page revoked");
      setConfirmRevokeAll(false);
      await sessions.refetch();
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  const columns: DataTableColumn<SessionJSON>[] = [
    {
      id: "status",
      header: "Status",
      cell: (session) => <StatusBadge status={session.status} />,
    },
    {
      id: "created",
      header: "Created",
      cell: (session) => <TimeAgo value={session.created_at} className="text-sm" />,
    },
    {
      id: "last_active",
      header: "Last active",
      cell: (session) => <TimeAgo value={session.last_active_at} className="text-sm" />,
    },
    {
      id: "expires",
      header: "Expires",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (session) => <span className="text-sm text-muted-foreground">{formatDateTime(session.expire_at)}</span>,
    },
    {
      id: "device",
      header: "Device",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (session) => (
        <div className="text-xs text-muted-foreground">
          <p>{session.latest_activity?.browser_name || "Unknown browser"}</p>
          <p className="font-mono">{session.latest_activity?.ip_address || "—"}</p>
        </div>
      ),
    },
    {
      id: "id",
      header: "Session ID",
      headerClassName: "hidden xl:table-cell",
      className: "hidden xl:table-cell",
      cell: (session) => <code className="text-xs text-muted-foreground">{session.id}</code>,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10 text-right",
      cell: (session) => (
        <Button
          size="xs"
          variant="outline"
          disabled={pendingId !== null || session.status !== "active"}
          onClick={() => void revoke(session)}
        >
          <LogOut aria-hidden /> Revoke
        </Button>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Every device where this user has an active or past session.</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[140px]" aria-label="Filter by status">
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
          <Button size="sm" variant="outline" onClick={() => setConfirmRevokeAll(true)} disabled={!rows.some((s) => s.status === "active")}>
            <LogOut aria-hidden /> Revoke active
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(session) => session.id}
          isLoading={sessions.isLoading}
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
          loadingRows={5}
          empty={<EmptyState title="No sessions" description="Sessions are created when the user signs in." />}
        />
        <TablePagination
          page={page}
          limit={limit}
          total={sessions.data?.total_count ?? 0}
          onPageChange={setPage}
          onLimitChange={(value) => {
            setLimit(value);
            setPage(1);
          }}
          disabled={sessions.isFetching}
        />
      </CardContent>
      <ConfirmDialog
        open={confirmRevokeAll}
        onOpenChange={setConfirmRevokeAll}
        title="Revoke active sessions on this page?"
        description="The user is signed out on the devices listed above."
        confirmLabel="Revoke"
        destructive
        pending={pendingId === "all"}
        onConfirm={() => void revokeAll()}
      />
    </Card>
  );
}
