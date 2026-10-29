import { useEffect, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { Clock, MailPlus, Search, Trash2, UserX, X } from "lucide-react";
import { toast } from "sonner";
import type { WaitlistEntryJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatDate } from "../lib/format";
import { buildListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { useDebounced } from "../lib/hooks";
import { PageHeader } from "../components/shared/page-header";
import { DataTable, type DataTableColumn } from "../components/shared/data-table";
import { TablePagination } from "../components/shared/table-pagination";
import { EmptyState } from "../components/shared/empty-state";
import { StatusBadge } from "../components/shared/status-badge";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { SecretReveal } from "../components/shared/secret-reveal";

const STATUSES = ["all", "pending", "invited", "completed", "rejected"];

export default function WaitlistPage() {
  const table = useTableState({ limit: 20, orderBy: "-created_at", filterKeys: ["status"] });
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(table.query);
  const debounced = useDebounced(search, 300);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState<WaitlistEntryJSON | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    if (debounced !== table.query) table.setQuery(debounced);
  }, [debounced]);
  useEffect(() => setSearch(table.query), [table.query]);
  useEffect(() => setSelected(new Set()), [table.searchParams]);

  const status = table.filter("status") || "all";
  const path = buildListPath("/waitlist_entries", {
    limit: table.limit,
    page: table.page,
    query: table.query,
    orderBy: table.orderBy,
    extra: { status: status === "all" ? undefined : status },
  });
  const entries = useApi<{ data: WaitlistEntryJSON[]; total_count: number }>(["waitlist", path], path, {
    placeholderData: keepPreviousData,
  });
  const rows = entries.data?.data ?? [];
  const allSelected = rows.length > 0 && rows.every((entry) => selected.has(entry.id));
  const someSelected = rows.some((entry) => selected.has(entry.id));

  async function refresh() {
    await Promise.all([
      entries.refetch(),
      queryClient.invalidateQueries({ queryKey: ["stats"] }),
      queryClient.invalidateQueries({ queryKey: ["invitations"] }),
    ]);
  }

  async function invite(entry: WaitlistEntryJSON) {
    setPending(entry.id);
    try {
      const result = await api<{ invitation?: { url?: string } | null }>("POST", `/waitlist_entries/${entry.id}/invite`);
      toast.success(`Invitation sent to ${entry.email_address}`);
      if (result?.invitation?.url) setInviteUrl(result.invitation.url);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function reject(entry: WaitlistEntryJSON) {
    setPending(entry.id);
    try {
      await api("POST", `/waitlist_entries/${entry.id}/reject`);
      toast.success("Entry rejected");
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function deleteEntry(entry: WaitlistEntryJSON) {
    setPending(entry.id);
    try {
      await api("DELETE", `/waitlist_entries/${entry.id}`);
      toast.success("Entry deleted");
      setDeleting(null);
      await refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(null);
    }
  }

  async function bulk(action: "invite" | "reject" | "delete") {
    const ids = [...selected];
    if (!ids.length) return;
    setPending("bulk");
    let failures = 0;
    await Promise.all(
      ids.map(async (id) => {
        try {
          if (action === "invite") await api("POST", `/waitlist_entries/${id}/invite`);
          else if (action === "reject") await api("POST", `/waitlist_entries/${id}/reject`);
          else await api("DELETE", `/waitlist_entries/${id}`);
        } catch {
          failures += 1;
        }
      }),
    );
    setPending(null);
    setConfirmBulkDelete(false);
    setSelected(new Set());
    await refresh();
    if (failures) toast.error(`${ids.length - failures} of ${ids.length} entries updated`);
    else toast.success(`${ids.length} entries ${action === "invite" ? "invited" : action === "reject" ? "rejected" : "deleted"}`);
  }

  const columns: DataTableColumn<WaitlistEntryJSON>[] = [
    {
      id: "select",
      className: "w-9",
      headerClassName: "w-9",
      header: (
        <Checkbox
          checked={allSelected ? true : someSelected ? "indeterminate" : false}
          onCheckedChange={(checked) =>
            setSelected((current) => {
              const next = new Set(current);
              for (const entry of rows) {
                if (checked === true) next.add(entry.id);
                else next.delete(entry.id);
              }
              return next;
            })
          }
          aria-label="Select all waitlist entries on this page"
        />
      ),
      cell: (entry) => (
        <Checkbox
          checked={selected.has(entry.id)}
          onCheckedChange={(checked) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked === true) next.add(entry.id);
              else next.delete(entry.id);
              return next;
            })
          }
          aria-label={`Select ${entry.email_address}`}
        />
      ),
    },
    {
      id: "email",
      header: "Email",
      cell: (entry) => <span className="font-data text-[0.8125rem]">{entry.email_address}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: (entry) => <StatusBadge status={entry.status} />,
    },
    {
      id: "invitation",
      header: "Invitation",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (entry) =>
        entry.invitation ? (
          <StatusBadge status={entry.invitation.status} label={`Invitation ${entry.invitation.status}`} />
        ) : (
          <span className="text-xs text-muted-foreground">None</span>
        ),
    },
    {
      id: "created",
      header: "Joined waitlist",
      sortKey: "created_at",
      cell: (entry) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(entry.created_at)}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-52 text-right",
      cell: (entry) => (
        <div className="flex justify-end gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={pending !== null || entry.status === "invited" || entry.status === "completed"}
            onClick={() => void invite(entry)}
            aria-label={`Invite ${entry.email_address}`}
          >
            <MailPlus aria-hidden /> Invite
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={pending !== null || entry.status === "rejected"}
            onClick={() => void reject(entry)}
            aria-label={`Reject ${entry.email_address}`}
          >
            <UserX aria-hidden /> Reject
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Delete ${entry.email_address}`}
            disabled={pending !== null}
            onClick={() => setDeleting(entry)}
          >
            <Trash2 aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Waitlist"
        description="Approve or reject people waiting for access to your application."
      />

      <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
        <div className="relative min-w-56 flex-1 max-w-md">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.5}
            aria-hidden
          />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search waitlist"
            aria-label="Search waitlist"
            className="h-[34px] pl-8"
          />
        </div>
        <Select value={status} onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}>
          <SelectTrigger className="h-[34px] w-[132px]" aria-label="Filter waitlist by status">
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
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void bulk("invite")}>
              <MailPlus aria-hidden /> Invite
            </Button>
            <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void bulk("reject")}>
              <UserX aria-hidden /> Reject
            </Button>
            <Button
              size="sm"
              variant="destructive"
              disabled={pending !== null}
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
        rowKey={(entry) => entry.id}
        isLoading={entries.isLoading}
        error={entries.error}
        onRetry={() => void entries.refetch()}
        sortKey={table.sortKey}
        sortDescending={table.sortDescending}
        onSort={table.toggleSort}
        empty={
          <EmptyState
            icon={Clock}
            title={table.hasFilters ? "No waitlist entries match" : "The waitlist is empty"}
            description={
              table.hasFilters
                ? "Clear the status filter or search for another address."
                : "Entries arrive when sign-up mode is set to waitlist and someone signs up."
            }
          />
        }
      />

      <TablePagination
        page={table.page}
        limit={table.limit}
        total={entries.data?.total_count ?? 0}
        onPageChange={table.setPage}
        onLimitChange={table.setLimit}
        disabled={entries.isFetching}
      />

      <SecretReveal
        open={!!inviteUrl}
        onOpenChange={(open) => {
          if (!open) setInviteUrl(null);
        }}
        title="Invitation link"
        description="Send this link to the waitlisted person if email delivery is not configured."
        secret={inviteUrl ?? ""}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete waitlist entry?"
        description={deleting ? `${deleting.email_address} is removed from the waitlist. An invitation already sent keeps working.` : undefined}
        confirmLabel="Delete entry"
        destructive
        pending={pending === deleting?.id}
        onConfirm={() => {
          if (deleting) void deleteEntry(deleting);
        }}
      />
      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`Delete ${selected.size} waitlist entr${selected.size === 1 ? "y" : "ies"}?`}
        description="The selected entries are removed from the waitlist. Invitations already sent keep working."
        confirmLabel="Delete entries"
        destructive
        pending={pending === "bulk"}
        onConfirm={() => void bulk("delete")}
      />
    </>
  );
}
