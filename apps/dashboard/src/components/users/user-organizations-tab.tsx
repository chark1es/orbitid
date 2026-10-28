import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { Building2, Plus, Search, Trash2, UserPlus } from "lucide-react";
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
import { EmptyState } from "../shared/empty-state";
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add to organization</DialogTitle>
          <DialogDescription>Search for an organization, then choose the member's role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-search">Organization</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                id="org-search"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOrganization(null);
                }}
                placeholder="Search by name or slug…"
                className="pl-8"
              />
            </div>
            {(orgs.data?.data?.length ?? 0) > 0 ? (
              <ul className="max-h-48 overflow-y-auto rounded-md border">
                {orgs.data?.data?.map((option) => (
                  <li key={option.id}>
                    <button
                      type="button"
                      onClick={() => setOrganization(option)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
                        organization?.id === option.id ? "bg-accent" : ""
                      }`}
                    >
                      <span className="truncate">{option.name}</span>
                      <span className="text-xs text-muted-foreground">{option.slug}</span>
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

function MembershipRow({
  membership,
  user,
  onChanged,
}: {
  membership: OrganizationMembershipJSON;
  user: UserJSON;
  onChanged: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, setPending] = useState(false);
  const org = membership.organization;

  async function remove() {
    setPending(true);
    try {
      await api("DELETE", `/organizations/${org.id}/memberships/${user.id}`);
      toast.success("Member removed");
      setConfirmRemove(false);
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <UserAvatar name={org.name} imageUrl={org.image_url} size="sm" />
      <div className="min-w-0 flex-1">
        <Link to={`/organizations/${org.id}`} className="truncate text-sm font-medium hover:underline">
          {org.name}
        </Link>
        <p className="truncate text-xs text-muted-foreground">
          {org.slug} · joined {formatDate(membership.created_at)}
        </p>
      </div>
      <Badge variant="outline" className="hidden sm:inline-flex">
        {org.members_count ?? 0} members
      </Badge>
      <OrganizationRoleSelect orgId={org.id} userId={user.id} role={membership.role} onChanged={onChanged} />
      <Button size="icon" variant="ghost" aria-label={`Remove from ${org.name}`} onClick={() => setConfirmRemove(true)}>
        <Trash2 aria-hidden />
      </Button>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove from ${org.name}?`}
        description="The user loses the role and every permission granted by this organization."
        confirmLabel="Remove member"
        destructive
        pending={pending}
        onConfirm={() => void remove()}
      />
    </li>
  );
}

export function UserOrganizationsTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const memberships = useApi<unknown>(["user-memberships", user.id], `/users/${user.id}/organization_memberships?limit=100`);
  const rows = asList<OrganizationMembershipJSON>(memberships.data).data;

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle>Organizations</CardTitle>
          <CardDescription>Memberships and roles for this user.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus aria-hidden /> Add to organization
        </Button>
      </CardHeader>
      <CardContent>
        {memberships.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : memberships.error ? (
          <p role="alert" className="py-6 text-sm text-destructive">
            {errorMessage(memberships.error)}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="No organization memberships"
            description="Add this user to an organization to grant roles and permissions."
          />
        ) : (
          <ul className="divide-y">
            {rows.map((membership) => (
              <MembershipRow
                key={membership.id}
                membership={membership}
                user={user}
                onChanged={() => {
                  void memberships.refetch();
                  onUpdated();
                }}
              />
            ))}
          </ul>
        )}
      </CardContent>
      <AddToOrganizationDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        user={user}
        onAdded={() => {
          void memberships.refetch();
          onUpdated();
        }}
      />
    </Card>
  );
}
