import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SearchInput,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { OVERLAY_WIDTH } from "../shared/overlay-sizes";
import { UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import type { OrganizationJSON, OrganizationMembershipJSON, UserJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDate, primaryEmail, userLabel } from "../../lib/format";
import { useDebounced } from "../../lib/hooks";
import { useOrganizationRoles, roleLabel } from "../../lib/organizations";
import { buildListPath } from "../../lib/query";
import { asList } from "../../lib/types";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { TablePagination } from "../shared/table-pagination";
import { EmptyState } from "../shared/empty-state";
import { UserAvatar } from "../shared/user-avatar";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Section } from "../shared/section";
import { OrganizationRoleSelect } from "./role-select";

function AddMemberDialog({
  org,
  open,
  onOpenChange,
  onAdded,
}: {
  org: OrganizationJSON;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const [selected, setSelected] = useState<UserJSON | null>(null);
  const [role, setRole] = useState("org:member");
  const [pending, setPending] = useState(false);
  const { roles } = useOrganizationRoles(org.id);
  const users = useApi<{ data: UserJSON[] }>(
    ["member-user-search", debounced],
    `/users?query=${encodeURIComponent(debounced)}&limit=8&paginated=true`,
    { enabled: open && debounced.length >= 1 },
  );

  async function submit() {
    if (!selected) return;
    setPending(true);
    try {
      await api("POST", `/organizations/${org.id}/memberships`, { user_id: selected.id, role });
      toast.success(`${userLabel(selected)} added`);
      onAdded();
      onOpenChange(false);
      setSearch("");
      setSelected(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={OVERLAY_WIDTH.form}>
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>Add an existing user to {org.name} with a role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="member-search">Find user</Label>
            <SearchInput
              id="member-search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelected(null);
              }}
              placeholder="Search email, username or user ID…"
            />
            {(users.data?.data?.length ?? 0) > 0 ? (
              <ul className="max-h-48 overflow-y-auto rounded-[4px] border border-border">
                {users.data?.data?.map((user) => (
                  <li key={user.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(user)}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                        selected?.id === user.id ? "bg-accent" : ""
                      }`}
                    >
                      <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="sm" className="size-6" />
                      <span className="min-w-0 flex-1 truncate">{userLabel(user)}</span>
                      <span className="truncate text-xs text-muted-foreground">{primaryEmail(user)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : debounced && !users.isFetching ? (
              <p className="text-xs text-muted-foreground">No users found.</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger aria-label="Role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.name || roleLabel(option.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!selected || pending}>
            <UserPlus aria-hidden /> Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrganizationMembersTab({ org, onChanged }: { org: OrganizationJSON; onChanged: () => void }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<OrganizationMembershipJSON | null>(null);
  const [pending, setPending] = useState(false);

  const path = buildListPath(`/organizations/${org.id}/memberships`, {
    limit,
    page,
    query: debounced,
    orderBy: "-created_at",
  });
  const memberships = useApi<unknown>(["organization-memberships", org.id, path], path);
  const rows = asList<OrganizationMembershipJSON>(memberships.data).data;
  const total = asList<OrganizationMembershipJSON>(memberships.data).total_count;

  async function remove() {
    if (!removing) return;
    setPending(true);
    try {
      await api("DELETE", `/organizations/${org.id}/memberships/${removing.public_user_data.user_id}`);
      toast.success("Member removed");
      setRemoving(null);
      await memberships.refetch();
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<OrganizationMembershipJSON>[] = [
    {
      id: "member",
      header: "Member",
      cell: (membership) => {
        const name = [membership.public_user_data.first_name, membership.public_user_data.last_name].filter(Boolean).join(" ") || membership.public_user_data.user_id;
        return (
          <div className="flex items-center gap-2.5">
            <UserAvatar name={name} imageUrl={membership.public_user_data.image_url} size="sm" />
            <div className="min-w-0">
              <Link to={`/users/${membership.public_user_data.user_id}`} className="truncate text-sm font-medium hover:underline">
                {name}
              </Link>
              <p className="truncate text-[0.8125rem] text-muted-foreground">{membership.public_user_data.identifier}</p>
            </div>
          </div>
        );
      },
    },
    {
      id: "role",
      header: "Role",
      cell: (membership) => (
        <OrganizationRoleSelect
          orgId={org.id}
          userId={membership.public_user_data.user_id}
          role={membership.role}
          onChanged={() => {
            void memberships.refetch();
            onChanged();
          }}
        />
      ),
    },
    {
      id: "joined",
      header: "Joined",
      cell: (membership) => <span className="font-data text-xs text-muted-foreground">{formatDate(membership.created_at)}</span>,
    },
    {
      id: "permissions",
      header: "Permissions",
      headerClassName: "hidden xl:table-cell",
      className: "hidden xl:table-cell",
      cell: (membership) => (
        <span className="font-data text-xs text-muted-foreground">{membership.permissions.length} granted</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-24 text-right",
      cell: (membership) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${membership.public_user_data.identifier}`}
          onClick={() => setRemoving(membership)}
        >
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Section
      title="Members"
      description="People who belong to this organization and the role each one holds."
      actions={
        <>
          <SearchInput
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search members…"
            aria-label="Search members"
            className="w-52"
          />
          <Button onClick={() => setAddOpen(true)}>
            <UserPlus aria-hidden /> Add member
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(membership) => membership.id}
          isLoading={memberships.isLoading}
          error={memberships.error}
          onRetry={() => void memberships.refetch()}
          loadingRows={5}
          empty={
            <EmptyState
              icon={Users}
              title={debounced ? "No members match this search" : "No members yet"}
              description={debounced ? "Try another name or identifier." : "Add members by email once they have signed up."}
            />
          }
        />
        <TablePagination
          page={page}
          limit={limit}
          total={total}
          onPageChange={setPage}
          onLimitChange={(value) => {
            setLimit(value);
            setPage(1);
          }}
          disabled={memberships.isFetching}
        />
      </div>

      <AddMemberDialog
        org={org}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          void memberships.refetch();
          onChanged();
        }}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title="Remove member?"
        description={
          removing
            ? `${removing.public_user_data.identifier} loses access to ${org.name}.`
            : undefined
        }
        confirmLabel="Remove member"
        destructive
        pending={pending}
        onConfirm={() => void remove()}
      />
    </Section>
  );
}
