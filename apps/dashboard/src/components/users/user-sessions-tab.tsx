import { useState } from "react";
import {
  Button,
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
import { revokeAllUserSessions } from "../../lib/user-admin";
import { formatSessionExpiry } from "../../lib/format";
import { buildListPath } from "../../lib/query";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { TablePagination } from "../shared/table-pagination";
import { StatusBadge } from "../shared/status-badge";
import { TimeAgo } from "../shared/time-ago";
import { EmptyState } from "../shared/empty-state";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Section } from "../shared/section";

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
      // Every active session, not only the rows on this page: the dialog promises all devices and the
      // helper walks the live `status=active` list until it is empty.
      const result = await revokeAllUserSessions(user.id);
      if (result.failed > 0) toast.error(`Revoked ${result.revoked} of ${result.total} sessions`);
      else toast.success(result.revoked === 0 ? "No active sessions to revoke" : "All active sessions revoked");
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
      cell: (session) => (
        <div className="space-y-1">
          <StatusBadge status={session.status} />
          {session.second_factor_skipped_by_trusted_device ? (
            <StatusBadge status="skipped" tone="info" label="Second factor skipped: trusted device" />
          ) : null}
        </div>
      ),
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
      cell: (session) => (
        <span className="font-data text-xs text-muted-foreground">{formatSessionExpiry(session.expire_at)}</span>
      ),
    },
    {
      id: "device",
      header: "Device",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      cell: (session) => (
        <div className="text-xs text-muted-foreground">
          <p>{session.latest_activity?.browser_name || "Unknown browser"}</p>
          <p className="font-data">{session.latest_activity?.ip_address || "Unknown IP"}</p>
        </div>
      ),
    },
    {
      id: "id",
      header: "Session ID",
      headerClassName: "hidden xl:table-cell",
      className: "hidden xl:table-cell",
      cell: (session) => <code className="font-data text-xs text-muted-foreground">{session.id}</code>,
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
    <Section
      title="Sessions"
      description="Every device where this user has an active or past session."
      className="border-t-0 pt-0"
      actions={
        <>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[140px]" aria-label="Filter by status">
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
          <Button
            variant="outline"
            onClick={() => setConfirmRevokeAll(true)}
            disabled={!rows.some((session) => session.status === "active")}
          >
            <LogOut aria-hidden /> Revoke active sessions
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(session) => session.id}
          isLoading={sessions.isLoading}
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
          loadingRows={5}
          empty={<EmptyState variant="compact" title="No sessions" description="Sessions are created when the user signs in." />}
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
      </div>
      <ConfirmDialog
        open={confirmRevokeAll}
        onOpenChange={setConfirmRevokeAll}
        title="Revoke every active session?"
        description="The user is signed out on every device, not only the sessions on this page."
        confirmLabel="Revoke"
        destructive
        pending={pendingId === "all"}
        onConfirm={() => void revokeAll()}
      />
    </Section>
  );
}
