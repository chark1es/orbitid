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
import { Building2, Plus, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import type { OrganizationJSON, OrganizationMembershipJSON, UserJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { useDebounced } from "../../lib/hooks";
import { roleLabel, useOrganizationRoles } from "../../lib/organizations";
import { OrganizationRoleSelect } from "../organizations/role-select";
import { asList } from "../../lib/types";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { Section } from "../shared/section";
import { UserAvatar } from "../shared/user-avatar";

function AddToOrganizationDialog({
  open,
  onOpenChange,
  user,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserJSON;
  onAdded: () => void;
}) {
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const [organization, setOrganization] = useState<OrganizationJSON | null>(null);
  const [role, setRole] = useState("org:member");
  const [pending, setPending] = useState(false);
  const orgs = useApi<{ data: OrganizationJSON[] }>(
    ["organization-search", debounced],
    `/organizations?query=${encodeURIComponent(debounced)}&limit=8`,
    { enabled: open && debounced.length >= 1 },
  );
  const { roles } = useOrganizationRoles(organization?.id);

  async function submit() {
    if (!organization) return;
    setPending(true);
    try {
      await api("POST", `/organizations/${organization.id}/memberships`, { user_id: user.id, role });
      toast.success(`Added to ${organization.name}`);
      onAdded();
      onOpenChange(false);
      setSearch("");
      setOrganization(null);
      setRole("org:member");
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
          <DialogTitle>Add to organization</DialogTitle>
          <DialogDescription>Search for an organization, then choose the member's role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-search">Organization</Label>
            <SearchInput
              id="org-search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setOrganization(null);
              }}
              placeholder="Search by name or slug…"
            />
            {(orgs.data?.data?.length ?? 0) > 0 ? (
              <ul className="max-h-48 overflow-y-auto rounded-[4px] border border-border">
                {orgs.data?.data?.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => setOrganization(option)}
                      aria-pressed={organization?.id === option.id}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${
                        organization?.id === option.id ? "bg-accent" : ""
                      }`}
                    >
                      <span className="truncate">{option.name}</span>
                      <span className="truncate font-data text-xs text-muted-foreground">{option.slug}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : debounced && !orgs.isFetching ? (
              <p className="text-xs text-muted-foreground">No organizations found.</p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={setRole} disabled={!organization}>
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
          <Button onClick={() => void submit()} disabled={!organization || pending}>
            <UserPlus aria-hidden /> Add member
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function UserOrganizationsTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [removing, setRemoving] = useState<OrganizationMembershipJSON | null>(null);
  const [pending, setPending] = useState(false);
  const memberships = useApi<unknown>(["user-memberships", user.id], `/users/${user.id}/organization_memberships?limit=100`);
  const rows = asList<OrganizationMembershipJSON>(memberships.data).data;

  async function remove() {
    if (!removing) return;
    setPending(true);
    try {
      await api("DELETE", `/organizations/${removing.organization.id}/memberships/${user.id}`);
      toast.success("Member removed");
      setRemoving(null);
      await memberships.refetch();
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<OrganizationMembershipJSON>[] = [
    {
      id: "organization",
      header: "Organization",
      cell: (membership) => {
        const org = membership.organization;
        return (
          <div className="flex items-center gap-2.5">
            <UserAvatar name={org.name} imageUrl={org.image_url} size="sm" />
            <div className="min-w-0">
              <Link to={`/organizations/${org.id}`} className="truncate text-sm font-medium hover:underline">
                {org.name}
              </Link>
              <p className="truncate font-data text-xs text-muted-foreground">{org.slug}</p>
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
          orgId={membership.organization.id}
          userId={user.id}
          role={membership.role}
          onChanged={() => {
            void memberships.refetch();
            onUpdated();
          }}
        />
      ),
    },
    {
      id: "joined",
      header: "Joined",
      cell: (membership) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(membership.created_at)}</span>
      ),
    },
    {
      id: "members",
      header: "Members",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (membership) => (
        <span className="font-data text-xs text-muted-foreground">
          {membership.organization.members_count ?? 0} members
        </span>
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
          aria-label={`Remove from ${membership.organization.name}`}
          onClick={() => setRemoving(membership)}
        >
          <Trash2 aria-hidden /> Remove
        </Button>
      ),
    },
  ];

  return (
    <Section
      title="Organizations"
      description="Memberships and roles for this user."
      className="border-t-0 pt-0"
      actions={
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus aria-hidden /> Add to organization
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(membership) => membership.id}
        isLoading={memberships.isLoading}
        error={memberships.error}
        onRetry={() => void memberships.refetch()}
        loadingRows={4}
        empty={
          <EmptyState
            icon={Building2}
            title="No organization memberships"
            description="Add this user to an organization to grant roles and permissions."
          />
        }
      />
      <AddToOrganizationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        user={user}
        onAdded={() => {
          void memberships.refetch();
          onUpdated();
        }}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Remove from ${removing.organization.name}?` : "Remove member?"}
        description="The user loses the role and every permission granted by this organization."
        confirmLabel="Remove member"
        destructive
        pending={pending}
        onConfirm={() => void remove()}
      />
    </Section>
  );
}
