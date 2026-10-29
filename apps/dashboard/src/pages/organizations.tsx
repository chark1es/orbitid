import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@orbitid/ui";
import { Building2, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { OrganizationJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatNumber } from "../lib/format";
import { buildListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { useDebounced } from "../lib/hooks";
import { PageHeader } from "../components/shared/page-header";
import { DataTable, type DataTableColumn } from "../components/shared/data-table";
import { TablePagination } from "../components/shared/table-pagination";
import { EmptyState } from "../components/shared/empty-state";
import { UserAvatar } from "../components/shared/user-avatar";
import { TimeAgo } from "../components/shared/time-ago";
import { ConfirmDialog } from "../components/shared/confirm-dialog";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function CreateOrganizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const created = await api<OrganizationJSON>("POST", "/organizations", {
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: ["organizations"] });
      toast.success("Organization created");
      onOpenChange(false);
      setName("");
      setSlug("");
      setSlugTouched(false);
      if (created?.id) navigate(`/organizations/${created.id}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-[6px] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-[650] tracking-[-0.01em]">Create organization</DialogTitle>
          <DialogDescription className="text-sm leading-6 text-muted-foreground">
            Organizations group members, roles, invitations and domains.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (!slugTouched) setSlug(slugify(event.target.value));
              }}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="org-slug">Slug</Label>
            <Input
              id="org-slug"
              value={slug}
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(slugify(event.target.value));
              }}
              placeholder="acme"
              className="font-data"
            />
            <p className="text-xs leading-5 text-muted-foreground">Lowercase letters, numbers and dashes.</p>
          </div>
          {error ? (
            <p role="alert" className="border border-signal/40 bg-signal/5 px-2.5 py-2 text-sm leading-6">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function OrganizationsPage() {
  const navigate = useNavigate();
  const table = useTableState({ limit: 20, orderBy: "-created_at" });
  const [search, setSearch] = useState(table.query);
  const debounced = useDebounced(search, 300);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<OrganizationJSON | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (debounced !== table.query) table.setQuery(debounced);
  }, [debounced]);
  useEffect(() => setSearch(table.query), [table.query]);

  const path = buildListPath("/organizations", {
    limit: table.limit,
    page: table.page,
    query: table.query,
    orderBy: table.orderBy,
  });
  const organizations = useApi<{ data: OrganizationJSON[]; total_count: number }>(["organizations", path], path, {
    placeholderData: keepPreviousData,
  });
  const rows = organizations.data?.data ?? [];

  const columns: DataTableColumn<OrganizationJSON>[] = [
    {
      id: "name",
      header: "Organization",
      cell: (org) => (
        <div className="flex items-center gap-2.5">
          <UserAvatar name={org.name} imageUrl={org.image_url} size="sm" />
          <div className="min-w-0">
            <Link
              to={`/organizations/${org.id}`}
              className="block max-w-[34ch] truncate text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {org.name}
            </Link>
            <span className="block truncate font-data text-[0.6875rem] text-muted-foreground">{org.slug}</span>
          </div>
        </div>
      ),
    },
    {
      id: "members",
      header: "Members",
      cell: (org) => (
        <span className="font-data text-xs tabular-nums">{formatNumber(org.members_count ?? 0)}</span>
      ),
    },
    {
      id: "invitations",
      header: "Pending invitations",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (org) => (
        <span className="font-data text-xs tabular-nums text-muted-foreground">
          {formatNumber(org.pending_invitations_count ?? 0)}
        </span>
      ),
    },
    {
      id: "created",
      header: "Created",
      sortKey: "created_at",
      cell: (org) => <TimeAgo value={org.created_at} className="font-data text-xs text-muted-foreground" />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-9 text-right",
      headerClassName: "w-9",
      cell: (org) => (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Delete ${org.name}`}
          onClick={(event) => {
            event.stopPropagation();
            setDeleting(org);
          }}
        >
          <Trash2 aria-hidden />
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Organizations"
        description="Every organization on this instance, with member and invitation counts."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden /> Create organization
          </Button>
        }
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
            placeholder="Search by name or slug"
            aria-label="Search organizations"
            className="h-[34px] pl-8"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(org) => org.id}
        isLoading={organizations.isLoading}
        error={organizations.error}
        onRetry={() => void organizations.refetch()}
        sortKey={table.sortKey}
        sortDescending={table.sortDescending}
        onSort={table.toggleSort}
        onRowClick={(org) => navigate(`/organizations/${org.id}`)}
        empty={
          <EmptyState
            icon={Building2}
            title={table.query ? "No organizations match this search" : "No organizations yet"}
            description={
              table.query
                ? "Search another name or slug, or clear the search."
                : "Create an organization here, or let users create their own from your app."
            }
            action={
              table.query ? (
                <Button variant="outline" size="sm" onClick={() => setSearch("")}>
                  Clear search
                </Button>
              ) : (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden /> Create organization
                </Button>
              )
            }
          />
        }
      />

      <TablePagination
        page={table.page}
        limit={table.limit}
        total={organizations.data?.total_count ?? 0}
        onPageChange={table.setPage}
        onLimitChange={table.setLimit}
        disabled={organizations.isFetching}
      />

      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete organization?"
        description={
          deleting
            ? `${deleting.name} is removed with every membership, invitation and domain. Members lose access immediately and this cannot be undone.`
            : undefined
        }
        confirmLabel="Delete organization"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api("DELETE", `/organizations/${deleting.id}`);
            toast.success("Organization deleted");
            setDeleting(null);
            await queryClient.invalidateQueries({ queryKey: ["organizations"] });
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
      />
    </>
  );
}
