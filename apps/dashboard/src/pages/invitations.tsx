import { useState } from "react";
import { Page as PageLayout } from "../components/shared/page";
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
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from "@orbitid/ui";
import { OVERLAY_WIDTH } from "../components/shared/overlay-sizes";
import { Ban, MailPlus } from "lucide-react";
import { toast } from "sonner";
import type { InvitationJSON } from "@orbitid/shared";
import { api, useApi } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { formatDate } from "../lib/format";
import { buildListPath } from "../lib/query";
import { useTableState } from "../lib/use-table-state";
import { useUrlSyncedInput } from "../lib/hooks";
import { PageHeader } from "../components/shared/page-header";
import { DataTable, type DataTableColumn } from "../components/shared/data-table";
import { TablePagination } from "../components/shared/table-pagination";
import { EmptyState } from "../components/shared/empty-state";
import { StatusBadge } from "../components/shared/status-badge";
import { CopyButton } from "../components/shared/copy-button";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { SecretReveal } from "../components/shared/secret-reveal";

const STATUSES = ["all", "pending", "accepted", "revoked", "expired"];

function parseEmails(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean))];
}

function CreateInvitationsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"single" | "bulk">("single");
  const [email, setEmail] = useState("");
  const [emails, setEmails] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [notify, setNotify] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const days = Number(expiresInDays) || undefined;
    try {
      if (mode === "single") {
        const invitation = await api<InvitationJSON>("POST", "/invitations", {
          email_address: email.trim(),
          notify,
          ...(days ? { expires_in_days: days } : {}),
        });
        if (invitation.url) setInviteUrl(invitation.url);
        toast.success("Invitation created");
      } else {
        const list = parseEmails(emails);
        await api<unknown>("POST", "/invitations/bulk", {
          email_addresses: list,
          notify,
          ...(days ? { expires_in_days: days } : {}),
        });
        toast.success(`${list.length} invitations created`);
      }
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      onOpenChange(false);
      setEmail("");
      setEmails("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  const valid = mode === "single" ? !!email.trim() : parseEmails(emails).length > 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={`rounded-[6px] ${OVERLAY_WIDTH.form}`}>
          <DialogHeader>
            <DialogTitle className="text-base font-heading tracking-[-0.01em]">Create invitation</DialogTitle>
            <DialogDescription className="text-sm leading-6 text-muted-foreground">
              Invitations are required when sign-up mode is restricted, or when the allowlist is on.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Mode</Label>
              <Select value={mode} onValueChange={(value) => setMode(value as "single" | "bulk")}>
                <SelectTrigger aria-label="Invitation mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Single invitation</SelectItem>
                  <SelectItem value="bulk">Bulk invitations</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {mode === "single" ? (
              <div className="space-y-1.5">
                <Label htmlFor="invitation-email">Email address</Label>
                <Input
                  id="invitation-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="new-user@example.com"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="invitation-emails">Email addresses</Label>
                <Textarea
                  id="invitation-emails"
                  value={emails}
                  onChange={(event) => setEmails(event.target.value)}
                  rows={5}
                  placeholder={"one@example.com\ntwo@example.com"}
                  className="font-data text-xs leading-6"
                />
                <p className="text-xs leading-5 text-muted-foreground">
                  Separate addresses with commas, spaces or new lines. Duplicates are dropped.
                </p>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="invitation-expiry">Expires in days</Label>
                <Input
                  id="invitation-expiry"
                  type="number"
                  min={1}
                  value={expiresInDays}
                  onChange={(event) => setExpiresInDays(event.target.value)}
                  className="font-data"
                />
              </div>
              <div className="flex items-center justify-between gap-3 sm:pt-6">
                <Label htmlFor="invitation-notify">Send email</Label>
                <Switch id="invitation-notify" checked={notify} onCheckedChange={setNotify} />
              </div>
            </div>
            {error ? (
              <p role="alert" className="border border-signal/40 bg-signal/5 px-2.5 py-2 text-sm leading-6">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => void submit()} disabled={!valid || pending}>
              <MailPlus aria-hidden /> Create {mode === "bulk" ? "invitations" : "invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SecretReveal
        open={!!inviteUrl}
        onOpenChange={(next) => {
          if (!next) setInviteUrl(null);
        }}
        title="Invitation link"
        description="Share this link if the recipient did not receive the email."
        secret={inviteUrl ?? ""}
      />
    </>
  );
}

export default function InvitationsPage() {
  const table = useTableState({ limit: 20, orderBy: "-created_at", filterKeys: ["status"] });
  const [search, setSearch] = useUrlSyncedInput(table.query, table.setQuery, 300);
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<InvitationJSON | null>(null);
  const [pending, setPending] = useState(false);

  const status = table.filter("status") || "all";
  const path = buildListPath("/invitations", {
    limit: table.limit,
    page: table.page,
    query: table.query,
    orderBy: table.orderBy,
    extra: { status: status === "all" ? undefined : status },
  });
  const invitations = useApi<{ data: InvitationJSON[]; total_count: number }>(["invitations", path], path, {
    placeholderData: keepPreviousData,
  });
  const rows = invitations.data?.data ?? [];

  async function revoke() {
    if (!revoking) return;
    setPending(true);
    try {
      await api("POST", `/invitations/${revoking.id}/revoke`);
      toast.success("Invitation revoked");
      setRevoking(null);
      await invitations.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<InvitationJSON>[] = [
    {
      id: "email",
      header: "Email",
      cell: (invitation) => (
        <span className="block max-w-[36ch] truncate text-[0.8125rem]" title={invitation.email_address}>
          {invitation.email_address}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (invitation) => <StatusBadge status={invitation.status} />,
    },
    {
      id: "created",
      header: "Created",
      sortKey: "created_at",
      cell: (invitation) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(invitation.created_at)}</span>
      ),
    },
    {
      id: "expires",
      header: "Expires",
      cell: (invitation) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(invitation.expires_at)}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-32 text-right",
      cell: (invitation) => (
        <div className="flex justify-end gap-1">
          {invitation.url ? <CopyButton value={invitation.url} label="Copy invitation URL" size="icon-sm" /> : null}
          <Button
            size="xs"
            variant="outline"
            disabled={invitation.status !== "pending"}
            onClick={() => setRevoking(invitation)}
            aria-label={`Revoke invitation for ${invitation.email_address}`}
          >
            <Ban aria-hidden /> Revoke
          </Button>
        </div>
      ),
    },
  ];

  return (
    <PageLayout>
      <PageHeader
        title="Invitations"
        description="Instance-level invitations used to gate sign-ups."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <MailPlus aria-hidden /> Create invitation
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-x-2 gap-y-3">
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search invitations"
          aria-label="Search invitations"
          className="min-w-56 max-w-md flex-1"
        />
        <Select value={status} onValueChange={(value) => table.setFilter("status", value === "all" ? null : value)}>
          <SelectTrigger className="h-[34px] w-[132px]" aria-label="Filter invitations by status">
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
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(invitation) => invitation.id}
        isLoading={invitations.isLoading}
        error={invitations.error}
        onRetry={() => void invitations.refetch()}
        sortKey={table.sortKey}
        sortDescending={table.sortDescending}
        onSort={table.toggleSort}
        empty={
          <EmptyState
            icon={MailPlus}
            title={table.hasFilters ? "No invitations match these filters" : "No invitations yet"}
            description={
              table.hasFilters
                ? "Clear the status filter or search for another address."
                : "Create one to let a specific person sign up while sign-ups are restricted."
            }
            action={
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <MailPlus aria-hidden /> Create invitation
              </Button>
            }
          />
        }
      />

      <TablePagination
        page={table.page}
        limit={table.limit}
        total={invitations.data?.total_count ?? 0}
        onPageChange={table.setPage}
        onLimitChange={table.setLimit}
        disabled={invitations.isFetching}
      />

      <CreateInvitationsDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title="Revoke invitation?"
        description={revoking ? `${revoking.email_address} can no longer use this invitation. You can send a new one.` : undefined}
        confirmLabel="Revoke invitation"
        destructive
        pending={pending}
        onConfirm={() => void revoke()}
      />
    </PageLayout>
  );
}
