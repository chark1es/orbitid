import { useState } from "react";
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
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { OVERLAY_WIDTH } from "../shared/overlay-sizes";
import { Ban, MailPlus } from "lucide-react";
import { toast } from "sonner";
import type { OrganizationInvitationJSON, OrganizationJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { useDebounced } from "../../lib/hooks";
import { roleLabel, useOrganizationRoles } from "../../lib/organizations";
import { buildListPath } from "../../lib/query";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { TablePagination } from "../shared/table-pagination";
import { EmptyState } from "../shared/empty-state";
import { StatusBadge } from "../shared/status-badge";
import { CopyButton } from "../shared/copy-button";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { SecretReveal } from "../shared/secret-reveal";
import { Section } from "../shared/section";

const STATUSES = ["all", "pending", "accepted", "revoked", "expired"];

function InviteDialog({
  org,
  open,
  onOpenChange,
  onCreated,
}: {
  org: OrganizationJSON;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (invitation: OrganizationInvitationJSON) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("org:member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { roles } = useOrganizationRoles(org.id);

  async function submit() {
    if (!email.trim()) return;
    setPending(true);
    setError(null);
    try {
      const invitation = await api<OrganizationInvitationJSON>("POST", `/organizations/${org.id}/invitations`, {
        email_address: email.trim(),
        role,
        notify: true,
      });
      onCreated(invitation);
      onOpenChange(false);
      setEmail("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={OVERLAY_WIDTH.form}>
        <DialogHeader>
          <DialogTitle>Invite to {org.name}</DialogTitle>
          <DialogDescription>The invitee receives an email with an acceptance link.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="invite-email">Email address</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="new-member@example.com"
              autoFocus
            />
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
          {error ? (
            <p role="alert" className="rounded-[3px] border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={pending || !email.trim()}>
            <MailPlus aria-hidden /> Send invitation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrganizationInvitationsTab({ org, onChanged }: { org: OrganizationJSON; onChanged: () => void }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search, 300);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<OrganizationInvitationJSON | null>(null);
  const [pending, setPending] = useState(false);

  const path = buildListPath(`/organizations/${org.id}/invitations`, {
    limit,
    page,
    query: debounced,
    orderBy: "-created_at",
    extra: { status: status === "all" ? undefined : status },
  });
  const invitations = useApi<{ data: OrganizationInvitationJSON[]; total_count: number }>(
    ["organization-invitations", org.id, path],
    path,
  );
  const rows = invitations.data?.data ?? [];

  async function revoke() {
    if (!revoking) return;
    setPending(true);
    try {
      await api("POST", `/organizations/${org.id}/invitations/${revoking.id}/revoke`);
      toast.success("Invitation revoked");
      setRevoking(null);
      await invitations.refetch();
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<OrganizationInvitationJSON>[] = [
    {
      id: "email",
      header: "Email",
      cell: (invitation) => <span className="text-[0.8125rem]">{invitation.email_address}</span>,
    },
    {
      id: "role",
      header: "Role",
      cell: (invitation) => <span className="text-sm">{invitation.role_name || roleLabel(invitation.role)}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: (invitation) => <StatusBadge status={invitation.status} />,
    },
    {
      id: "created",
      header: "Sent",
      cell: (invitation) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(invitation.created_at)}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-32 text-right",
      cell: (invitation) => (
        <div className="flex justify-end gap-1">
          {invitation.url ? <CopyButton value={invitation.url} label="Copy invitation URL" /> : null}
          <Button
            size="sm"
            variant="outline"
            disabled={invitation.status !== "pending" || pending}
            onClick={() => setRevoking(invitation)}
          >
            <Ban aria-hidden /> Revoke
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Section
      title="Invitations"
      description="Invite people by email and track each invitation's status."
      actions={
        <>
          <SearchInput
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search invitations…"
            aria-label="Search invitations"
            className="w-52"
          />
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-[130px]" aria-label="Filter invitations by status">
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
          <Button onClick={() => setInviteOpen(true)}>
            <MailPlus aria-hidden /> Invite
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(invitation) => invitation.id}
          isLoading={invitations.isLoading}
          error={invitations.error}
          onRetry={() => void invitations.refetch()}
          loadingRows={5}
          empty={
            <EmptyState
              icon={MailPlus}
              title={debounced || status !== "all" ? "No invitations match" : "No invitations yet"}
              description="Pending invitations appear here until they are accepted or revoked."
            />
          }
        />
        <TablePagination
          page={page}
          limit={limit}
          total={invitations.data?.total_count ?? 0}
          onPageChange={setPage}
          onLimitChange={(value) => {
            setLimit(value);
            setPage(1);
          }}
          disabled={invitations.isFetching}
        />
      </div>

      <InviteDialog
        org={org}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        onCreated={(invitation) => {
          void invitations.refetch();
          onChanged();
          if (invitation.url) setCreatedUrl(invitation.url);
        }}
      />
      <SecretReveal
        open={!!createdUrl}
        onOpenChange={(open) => {
          if (!open) setCreatedUrl(null);
        }}
        title="Invitation link"
        description="Share this link directly with the invitee if email delivery is not configured."
        secret={createdUrl ?? ""}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke invitation?"
        description={revoking ? `${revoking.email_address} will no longer be able to join ${org.name}.` : undefined}
        confirmLabel="Revoke"
        destructive
        pending={pending}
        onConfirm={() => void revoke()}
      />
    </Section>
  );
}
