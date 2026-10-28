import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { Ban, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { UserJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { primaryEmail, userLabel } from "../lib/format";
import { usersListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { useDebounced } from "../lib/hooks";
import { PageHeader } from "../components/shared/page-header";
import { DataTable, type DataTableColumn } from "../components/shared/data-table";
import { TablePagination } from "../components/shared/table-pagination";
import { EmptyState } from "../components/shared/empty-state";
import { StatusBadge } from "../components/shared/status-badge";
import { UserAvatar } from "../components/shared/user-avatar";
import { TimeAgo } from "../components/shared/time-ago";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { CreateUserDialog } from "../components/users/create-user-dialog";
import { UserRowActions } from "../components/users/user-row-actions";

const LIST_KEYS = ["banned", "locked", "mfa", "created_after", "created_before"];

function toDateInput(ms: string): string {
  if (!ms) return "";
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function dateInputToMs(value: string, endOfDay = false): number | null {
  if (!value) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export default function UsersPage() {
  const table = useTableState({ limit: 20, orderBy: "-created_at", filterKeys: LIST_KEYS });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState(table.query);
  const debouncedSearch = useDebounced(search, 300);
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState<"ban" | "delete" | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  useEffect(() => {
    if (debouncedSearch !== table.query) table.setQuery(debouncedSearch);
  }, [debouncedSearch]);

  useEffect(() => setSearch(table.query), [table.query]);
  useEffect(() => setSelected(new Set()), [table.searchParams]);

  const path = usersListPath({
    page: table.page,
    limit: table.limit,
    query: table.query,
    orderBy: table.orderBy,
    banned: table.filter("banned") === "true",
    locked: table.filter("locked") === "true",
    mfa: table.filter("mfa") === "true",
    createdAfter: table.filter("created_after") ? Number(table.filter("created_after")) : undefined,
    createdBefore: table.filter("created_before") ? Number(table.filter("created_before")) : undefined,
  });

  const users = useApi<{ data: UserJSON[]; total_count: number }>(["users", path], path, {
    placeholderData: keepPreviousData,
  });

  const rows = users.data?.data ?? [];
  const total = users.data?.total_count ?? 0;
  const allSelected = rows.length > 0 && rows.every((user) => selected.has(user.id));
  const someSelected = rows.some((user) => selected.has(user.id));

  function toggleAll(checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const user of rows) {
        if (checked) next.add(user.id);
        else next.delete(user.id);
      }
      return next;
    });
  }

  async function bulk(action: "ban" | "delete") {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkPending(action);
    let failures = 0;
    await Promise.all(
      ids.map(async (id) => {
        try {
          if (action === "ban") await api("POST", `/users/${id}/ban`);
          else await api("DELETE", `/users/${id}`);
        } catch {
          failures += 1;
        }
      }),
    );
    setBulkPending(null);
    setConfirmBulkDelete(false);
    setSelected(new Set());
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["users"] }),
      queryClient.invalidateQueries({ queryKey: ["stats"] }),
    ]);
    if (failures) toast.error(`${ids.length - failures} of ${ids.length} users updated`);
    else toast.success(action === "ban" ? `${ids.length} users banned` : `${ids.length} users deleted`);
  }

  const columns: DataTableColumn<UserJSON>[] = [
    {
      id: "select",
      className: "w-10",
      headerClassName: "w-10",
      header: (
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(checked) => toggleAll(checked === true)}
          aria-label="Select all users on this page"
        />
      ),
      cell: (user) => (
        <Checkbox
          checked={selected.has(user.id)}
          onCheckedChange={(checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked === true) next.add(user.id);
              else next.delete(user.id);
              return next;
            })
          }
          aria-label={`Select ${userLabel(user)}`}
        />
      ),
    },
    {
      id: "user",
      header: "User",
      cell: (user) => (
        <div className="flex items-center gap-2.5">
          <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{userLabel(user)}</p>
            <p className="truncate text-xs text-muted-foreground">{primaryEmail(user) || user.id}</p>
          </div>
        </div>
      ),
    },
    {
      id: "username",
      header: "Username",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      sortKey: "username",
      cell: (user) => <span className="text-sm text-muted-foreground">{user.username ?? "—"}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: (user) => (
        <div className="flex flex-wrap gap-1">
          {user.banned ? <StatusBadge status="banned" /> : null}
          {user.locked ? <StatusBadge status="locked" /> : null}
          {user.two_factor_enabled ? <StatusBadge status="enabled" label="MFA" /> : null}
          {!user.banned && !user.locked && !user.two_factor_enabled ? <Badge variant="outline">No flags</Badge> : null}
        </div>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortKey: "created_at",
      cell: (user) => <TimeAgo value={user.created_at} className="text-sm" />,
    },
    {
      id: "last_sign_in",
      header: "Last sign-in",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      sortKey: "last_sign_in_at",
      cell: (user) => <TimeAgo value={user.last_sign_in_at} className="text-sm" />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10 text-right",
      headerClassName: "w-10",
      cell: (user) => <UserRowActions user={user} />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Search, inspect and administer every account on this instance."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden /> Create user
          </Button>
        }
      />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search email, phone, username or user ID…"
              aria-label="Search users"
              className="pl-8"
            />
          </div>
          <Button
            type="button"
            variant={table.filter("banned") ? "default" : "outline"}
            size="sm"
            aria-pressed={!!table.filter("banned")}
            onClick={() => table.setFilter("banned", table.filter("banned") ? null : "true")}
          >
            <Ban aria-hidden /> Banned
          </Button>
          <Button
            type="button"
            variant={table.filter("locked") ? "default" : "outline"}
            size="sm"
            aria-pressed={!!table.filter("locked")}
            onClick={() => table.setFilter("locked", table.filter("locked") ? null : "true")}
          >
            Locked
          </Button>
          <Button
            type="button"
            variant={table.filter("mfa") ? "default" : "outline"}
            size="sm"
            aria-pressed={!!table.filter("mfa")}
            onClick={() => table.setFilter("mfa", table.filter("mfa") ? null : "true")}
          >
            Has MFA
          </Button>
          {table.hasFilters ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                table.reset();
              }}
            >
              <X aria-hidden /> Clear
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="created-after" className="text-xs text-muted-foreground">
              Created after
            </Label>
            <Input
              id="created-after"
              type="date"
              className="h-8 w-[150px]"
              value={toDateInput(table.filter("created_after"))}
              onChange={(event) => table.setFilter("created_after", dateInputToMs(event.target.value)?.toString() ?? null)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="created-before" className="text-xs text-muted-foreground">
              Created before
            </Label>
            <Input
              id="created-before"
              type="date"
              className="h-8 w-[150px]"
              value={toDateInput(table.filter("created_before"))}
              onChange={(event) => table.setFilter("created_before", dateInputToMs(event.target.value, true)?.toString() ?? null)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Rows</Label>
            <Select value={String(table.limit)} onValueChange={(value) => table.setLimit(Number(value))}>
              <SelectTrigger className="h-8 w-[84px]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[10, 20, 50, 100].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="ml-auto text-xs text-muted-foreground">
            Sorted by {table.orderBy.replace(/^-/, "").replace(/_/g, " ")}
            {table.sortDescending ? " (descending)" : " (ascending)"}
          </p>
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={bulkPending !== null} onClick={() => void bulk("ban")}>
              <Ban aria-hidden /> Ban
            </Button>
            <Button size="sm" variant="destructive" disabled={bulkPending !== null} onClick={() => setConfirmBulkDelete(true)}>
              <Trash2 aria-hidden /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(user) => user.id}
        isLoading={users.isLoading}
        error={users.error}
        onRetry={() => void users.refetch()}
        sortKey={table.sortKey}
        sortDescending={table.sortDescending}
        onSort={table.toggleSort}
        onRowClick={(user) => navigate(`/users/${user.id}`)}
        empty={
          <EmptyState
            icon={Search}
            title={table.hasFilters ? "No users match these filters" : "No users yet"}
            description={
              table.hasFilters ? "Try a different search term or clear the filters." : "Users appear here after their first sign-up."
            }
          />
        }
      />

      <TablePagination
        page={table.page}
        limit={table.limit}
        total={total}
        onPageChange={table.setPage}
        onLimitChange={table.setLimit}
        disabled={users.isFetching}
      />

      <p className="text-xs text-muted-foreground">
        Server-side pagination, search and sorting. Filters map to the Backend API user list query.
      </p>

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selected.size} user${selected.size === 1 ? "" : "s"}?`}
        description="Every selected user and their sessions, identifiers and memberships will be permanently removed."
        confirmLabel="Delete users"
        destructive
        pending={bulkPending === "delete"}
        onConfirm={() => void bulk("delete")}
      />
    </>
  );
}
