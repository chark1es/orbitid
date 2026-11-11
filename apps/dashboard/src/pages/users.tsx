import { useEffect, useState } from "react";
import { Page as PageLayout } from "../components/shared/page";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  Input,
  Label,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { Ban, ChevronDown, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { UserJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { primaryEmail, userLabel } from "../lib/format";
import { usersListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { isCompleteDateInput, useDateInputDraft } from "../lib/date-filter";
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

const LIST_KEYS = ["banned", "locked", "mfa", "is_anonymous", "created_after", "created_before"];

/** The label token from DESIGN.md: 0.75rem, weight 600, uppercase with +0.04em tracking. */
const FILTER_LABEL = "text-[0.75rem] font-semibold tracking-[0.04em] uppercase text-muted-foreground";

/** A date control whose picker stays clickable under a chevron matching the selects. */
const DATE_INPUT =
  "w-[142px] pr-8 text-sm tabular-nums [color-scheme:light] dark:[color-scheme:dark] [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-y-0 [&::-webkit-calendar-picker-indicator]:right-0 [&::-webkit-calendar-picker-indicator]:w-8 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0";

const ACCOUNT_TYPES = [
  { value: "all", label: "All" },
  { value: "registered", label: "Registered" },
  { value: "guests", label: "Guests" },
] as const;

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
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState(table.query);
  const debouncedSearch = useDebounced(search, 300);
  const [createdAfterDraft, setCreatedAfterDraft] = useDateInputDraft(toDateInput(table.filter("created_after")));
  const [createdBeforeDraft, setCreatedBeforeDraft] = useDateInputDraft(toDateInput(table.filter("created_before")));
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState<"ban" | "delete" | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  useEffect(() => {
    if (debouncedSearch !== table.query) table.setQuery(debouncedSearch);
  }, [debouncedSearch]);

  useEffect(() => setSearch(table.query), [table.query]);
  useEffect(() => setSelected(new Set()), [table.searchParams]);

  /** Write a date to the URL only when the draft is a complete date, or when the input was cleared. */
  const commitDateFilter = (key: "created_after" | "created_before", value: string, endOfDay = false) => {
    if (!value) {
      table.setFilter(key, null);
      return;
    }
    if (isCompleteDateInput(value)) table.setFilter(key, dateInputToMs(value, endOfDay)?.toString() ?? null);
  };

  const status = table.filter("banned") === "true" ? "banned" : table.filter("locked") === "true" ? "locked" : "all";
  const mfa = table.filter("mfa") === "true" ? "mfa" : "any";
  const accountType =
    table.filter("is_anonymous") === "true"
      ? "guests"
      : table.filter("is_anonymous") === "false"
        ? "registered"
        : "all";

  const path = usersListPath({
    page: table.page,
    limit: table.limit,
    query: table.query,
    orderBy: table.orderBy,
    banned: status === "banned",
    locked: status === "locked",
    mfa: mfa === "mfa",
    isAnonymous: accountType === "all" ? undefined : accountType === "guests",
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

  function setStatus(value: string) {
    const next = new URLSearchParams(searchParams);
    next.delete("banned");
    next.delete("locked");
    next.delete("page");
    if (value === "banned") next.set("banned", "true");
    if (value === "locked") next.set("locked", "true");
    setSearchParams(next, { replace: true });
  }

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
      className: "w-9",
      headerClassName: "w-9",
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
            <Link
              to={`/users/${user.id}`}
              className="block max-w-[32ch] truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {userLabel(user)}
            </Link>
            <span className="block max-w-[32ch] truncate text-[0.8125rem] text-muted-foreground">
              {primaryEmail(user) || user.id}
            </span>
          </div>
        </div>
      ),
    },
    {
      id: "username",
      header: "Username",
      headerClassName: "hidden xl:table-cell",
      className: "hidden xl:table-cell",
      sortKey: "username",
      cell: (user) => (
        <span className="block max-w-[24ch] truncate font-data text-xs text-muted-foreground" title={user.username ?? undefined}>
          {user.username ?? "—"}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (user) => (
        <div className="flex flex-wrap gap-1">
          {user.banned ? <StatusBadge status="banned" /> : null}
          {user.locked ? <StatusBadge status="locked" /> : null}
          {user.two_factor_enabled ? <StatusBadge status="enabled" label="MFA" /> : null}
          {user.is_anonymous ? <StatusBadge status="guest" tone="info" label="Guest" /> : null}
          {!user.banned && !user.locked && !user.two_factor_enabled && !user.is_anonymous ? (
            <StatusBadge status="active" />
          ) : null}
        </div>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortKey: "created_at",
      cell: (user) => <TimeAgo value={user.created_at} className="font-data text-xs text-muted-foreground" />,
    },
    {
      id: "last_sign_in",
      header: "Last sign-in",
      headerClassName: "hidden lg:table-cell",
      className: "hidden lg:table-cell",
      sortKey: "last_sign_in_at",
      cell: (user) => (
        <TimeAgo value={user.last_sign_in_at} className="font-data text-xs text-muted-foreground" fallback="Never" />
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-9 text-right",
      headerClassName: "w-9",
      cell: (user) => <UserRowActions user={user} />,
    },
  ];

  return (
    <PageLayout>
      <PageHeader
        title="Users"
        description="Search, inspect and administer every account on this instance."
        actions={
          <Button size="default" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden /> Create user
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
        <div className="min-w-56 flex-1 space-y-1">
          <Label htmlFor="users-search" className={FILTER_LABEL}>
            Search
          </Label>
          <SearchInput
            id="users-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search email, phone, username or user ID"
            className="min-w-56"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="users-status" className={FILTER_LABEL}>
            Status
          </Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger id="users-status" className="w-[132px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="banned">Banned</SelectItem>
              <SelectItem value="locked">Locked</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="users-mfa" className={FILTER_LABEL}>
            MFA
          </Label>
          <Select value={mfa} onValueChange={(value) => table.setFilter("mfa", value === "mfa" ? "true" : null)}>
            <SelectTrigger id="users-mfa" className="w-[124px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any MFA</SelectItem>
              <SelectItem value="mfa">Has MFA</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label
            htmlFor="users-account-type"
            className={FILTER_LABEL}
          >
            Account type
          </Label>
          <Select
            value={accountType}
            onValueChange={(value) =>
              table.setFilter("is_anonymous", value === "guests" ? "true" : value === "registered" ? "false" : null)
            }
          >
            <SelectTrigger id="users-account-type" className="w-[164px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCOUNT_TYPES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="created-after" className={FILTER_LABEL}>
              Created after
            </Label>
            <div className="relative">
              <Input
                id="created-after"
                type="date"
                className={DATE_INPUT}
                value={createdAfterDraft}
                onChange={(event) => {
                  setCreatedAfterDraft(event.target.value);
                  commitDateFilter("created_after", event.target.value);
                }}
              />
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground opacity-50"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="created-before" className={FILTER_LABEL}>
              Created before
            </Label>
            <div className="relative">
              <Input
                id="created-before"
                type="date"
                className={DATE_INPUT}
                value={createdBeforeDraft}
                onChange={(event) => {
                  setCreatedBeforeDraft(event.target.value);
                  commitDateFilter("created_before", event.target.value, true);
                }}
              />
              <ChevronDown
                aria-hidden
                className="pointer-events-none absolute top-1/2 right-2 size-4 -translate-y-1/2 text-muted-foreground opacity-50"
              />
            </div>
          </div>
        </div>
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

      {selected.size > 0 ? (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-2 rounded-[4px] border border-border bg-muted/40 px-3 py-2"
        >
          <span className="text-sm font-medium tabular-nums">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={bulkPending !== null} onClick={() => void bulk("ban")}>
              <Ban aria-hidden /> Ban
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={bulkPending !== null}
              onClick={() => setConfirmBulkDelete(true)}
            >
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
              table.hasFilters
                ? "Clear a filter or search for another identifier."
                : "Create the first user, or let someone sign up from your app. Sign-ups land here."
            }
            action={
              table.hasFilters ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSearch("");
                    table.reset();
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden /> Create user
                </Button>
              )
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

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selected.size} user${selected.size === 1 ? "" : "s"}?`}
        description="Every selected user and their sessions, identifiers and memberships are removed permanently. This cannot be undone."
        confirmLabel="Delete users"
        destructive
        pending={bulkPending === "delete"}
        onConfirm={() => void bulk("delete")}
      />
    </PageLayout>
  );
}
