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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { Globe, Plus } from "lucide-react";
import { toast } from "sonner";
import type { OrganizationDomainJSON, OrganizationJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { asList } from "../../lib/types";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { StatusBadge } from "../shared/status-badge";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Section } from "../shared/section";

const ENROLLMENT_MODES = [
  { value: "manual_invitation", label: "Manual invitation" },
  { value: "automatic_invitation", label: "Automatic invitation" },
  { value: "automatic_suggestion", label: "Automatic suggestion" },
] as const;

function AddDomainDialog({
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
  const [name, setName] = useState("");
  const [mode, setMode] = useState<string>("manual_invitation");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await api("POST", `/organizations/${org.id}/domains`, { name: name.trim(), enrollment_mode: mode });
      toast.success("Domain added");
      onAdded();
      onOpenChange(false);
      setName("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add domain</DialogTitle>
          <DialogDescription>
            Members with an email on this domain can be enrolled automatically. Domains must be verified before automatic
            enrollment takes effect.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="domain-name">Domain</Label>
            <Input
              id="domain-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="example.com"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>Enrollment mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger aria-label="Enrollment mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENROLLMENT_MODES.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
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
          <Button onClick={() => void submit()} disabled={pending || !name.trim()}>
            Add domain
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrganizationDomainsTab({ org, onChanged }: { org: OrganizationJSON; onChanged: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<OrganizationDomainJSON | null>(null);
  const [pending, setPending] = useState(false);
  const domainsQuery = useApi<unknown>(["organization-domains", org.id], `/organizations/${org.id}/domains?limit=100`);
  const domains = asList<OrganizationDomainJSON>(domainsQuery.data).data;

  async function remove() {
    if (!deleting) return;
    setPending(true);
    try {
      await api("DELETE", `/organizations/${org.id}/domains/${deleting.id}`);
      toast.success("Domain removed");
      setDeleting(null);
      await domainsQuery.refetch();
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<OrganizationDomainJSON>[] = [
    {
      id: "domain",
      header: "Domain",
      cell: (domain) => (
        <div className="flex items-center gap-2">
          <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate font-data text-sm">{domain.name}</span>
        </div>
      ),
    },
    {
      id: "enrollment",
      header: "Enrollment",
      cell: (domain) => (
        <span className="text-sm">
          {ENROLLMENT_MODES.find((option) => option.value === domain.enrollment_mode)?.label ??
            domain.enrollment_mode.replace(/_/g, " ")}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (domain) => <StatusBadge status={domain.verification?.status ?? "unverified"} />,
    },
    {
      id: "added",
      header: "Added",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (domain) => (
        <span className="font-data text-xs text-muted-foreground">{formatDate(domain.created_at)}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-24 text-right",
      cell: (domain) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove ${domain.name}`}
          onClick={() => setDeleting(domain)}
        >
          Remove
        </Button>
      ),
    },
  ];

  return (
    <Section
      title="Domains"
      description="Domain ownership drives automatic invitations and suggestions."
      actions={
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus aria-hidden /> Add domain
        </Button>
      }
    >
      <DataTable
        columns={columns}
        rows={domains}
        rowKey={(domain) => domain.id}
        isLoading={domainsQuery.isLoading}
        error={domainsQuery.error}
        onRetry={() => void domainsQuery.refetch()}
        loadingRows={3}
        empty={
          <EmptyState icon={Globe} title="No domains" description="Verify a domain to enroll teammates automatically." />
        }
      />

      <AddDomainDialog
        org={org}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          void domainsQuery.refetch();
          onChanged();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Remove domain?"
        description={deleting ? `${deleting.name} will no longer be associated with ${org.name}.` : undefined}
        confirmLabel="Remove domain"
        destructive
        pending={pending}
        onConfirm={() => void remove()}
      />
    </Section>
  );
}
