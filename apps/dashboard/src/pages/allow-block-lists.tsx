import { useState } from "react";
import type { AllowlistIdentifierJSON, BlocklistIdentifierJSON, PaginatedList } from "@orbitid/shared";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@orbitid/ui";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useApi, useApiMutation } from "../lib/api";
import { unwrapList } from "./_config/data";
import {
  errorMessage,
  formatDate,
  normalizeRestrictionIdentifier,
} from "./_config/settings";
import {
  CheckboxRow,
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  Field,
  LoadingPage,
  PageHeader,
  SaveBar,
  SectionCard,
  SwitchRow,
  TableSkeleton,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

type ListKind = "allow" | "block";
type IdentifierKind = "email" | "domain" | "phone";
interface RestrictionRow {
  id: string;
  identifier: string;
  identifier_type: string;
  created_at: number;
}

const fetchers = {
  allow: { path: "/allowlist_identifiers?limit=100", key: ["allowlist-identifiers"] },
  block: { path: "/blocklist_identifiers?limit=100", key: ["blocklist-identifiers"] },
} as const;

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [tab, setTab] = useState<ListKind>("allow");
  const [dialogKind, setDialogKind] = useState<ListKind | null>(null);
  const [identifierKind, setIdentifierKind] = useState<IdentifierKind>("email");
  const [identifier, setIdentifier] = useState("");
  const [notify, setNotify] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<RestrictionRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const allowQuery = useApi<PaginatedList<AllowlistIdentifierJSON>>([...fetchers.allow.key], fetchers.allow.path);
  const blockQuery = useApi<PaginatedList<BlocklistIdentifierJSON>>([...fetchers.block.key], fetchers.block.path);
  const allowRows = unwrapList<RestrictionRow>(allowQuery.data);
  const blockRows = unwrapList<RestrictionRow>(blockQuery.data);

  const addMutation = useApiMutation<Record<string, unknown>>("POST", dialogKind === "block" ? "/blocklist_identifiers" : "/allowlist_identifiers", {
    invalidate: dialogKind === "block" ? [[...fetchers.block.key]] : [[...fetchers.allow.key]],
    onSuccess: () => {
      toast.success(dialogKind === "block" ? "Identifier blocked" : "Identifier allowed");
      setDialogKind(null);
      setIdentifier("");
      setNotify(false);
    },
  });

  if (editor.isLoading) return <LoadingPage rows={3} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Allowlist & Blocklist" description="Control who can sign up." />
        <ErrorAlert error={editor.error ?? "Could not load instance settings."} onRetry={editor.refetch} />
      </div>
    );
  }

  const restrictions = settings.restrictions;
  const parsed = normalizeRestrictionIdentifier(identifierKind, identifier);
  const identifierError = identifier.trim() && !parsed ? `Enter a valid ${identifierKind === "domain" ? "domain" : identifierKind}.` : null;

  const openDialog = (kind: ListKind) => {
    setDialogKind(kind);
    setIdentifierKind("email");
    setIdentifier("");
    setNotify(false);
  };

  const submitIdentifier = async () => {
    if (!parsed) return;
    setAdding(true);
    try {
      const body: Record<string, unknown> = {
        identifier: parsed.identifier,
        identifier_type: parsed.identifier_type,
      };
      if (dialogKind === "allow") body.notify = notify;
      await addMutation.mutateAsync(body);
    } catch (error) {
      toast.error("Could not add identifier", { description: errorMessage(error) });
    } finally {
      setAdding(false);
    }
  };

  const deleteIdentifier = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      const base = tab === "allow" ? "/allowlist_identifiers" : "/blocklist_identifiers";
      await api("DELETE", `${base}/${selected.id}`);
      await (tab === "allow" ? allowQuery.refetch() : blockQuery.refetch());
      toast.success(tab === "allow" ? "Identifier removed from allowlist" : "Identifier removed from blocklist");
      setSelected(null);
    } catch (error) {
      toast.error("Could not remove identifier", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  const listTable = (rows: RestrictionRow[], kind: ListKind) => {
    const query = kind === "allow" ? allowQuery : blockQuery;
    if (query.isLoading) {
      return <TableSkeleton rows={4} />;
    }
    if (query.error) {
      return <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} />;
    }
    if (rows.length === 0) {
      return (
        <EmptyState
          title={kind === "allow" ? "No allowlisted identifiers" : "No blocked identifiers"}
          description={
            kind === "allow"
              ? "When the allowlist is enabled, only these emails, domains, and phone numbers can sign up."
              : "Blocked identifiers are rejected during sign-up even when the allowlist is off."
          }
          action={
            <Button size="sm" onClick={() => openDialog(kind)}>
              <Plus className="size-4" /> Add identifier
            </Button>
          }
        />
      );
    }
    return (
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Identifier</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-16" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-mono text-xs">{row.identifier}</TableCell>
                <TableCell>
                  <Badge variant="outline">{row.identifier_type.replace(/_/g, " ")}</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{formatDate(row.created_at)}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(row)} title="Remove">
                    <Trash2 className="size-4" />
                    <span className="sr-only">Remove</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Allowlist & Blocklist"
        description="Gate sign-ups by exact email address, entire email domains, or phone number."
        badge={
          <Badge variant={restrictions.allowlistEnabled || restrictions.blocklistEnabled ? "default" : "secondary"}>
            {restrictions.allowlistEnabled && restrictions.blocklistEnabled
              ? "Both enabled"
              : restrictions.allowlistEnabled
                ? "Allowlist enabled"
                : restrictions.blocklistEnabled
                  ? "Blocklist enabled"
                  : "Disabled"}
          </Badge>
        }
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SectionCard title="Enforcement" description="These switches take effect after saving instance settings.">
        <SwitchRow
          label="Enable allowlist"
          description="When enabled, only allowlisted identifiers (or users with a valid invitation) may sign up."
          checked={restrictions.allowlistEnabled}
          onCheckedChange={(allowlistEnabled) => editor.patch({ restrictions: { allowlistEnabled } })}
        />
        <SwitchRow
          label="Enable blocklist"
          description="Blocked identifiers are always rejected, regardless of the allowlist."
          checked={restrictions.blocklistEnabled}
          onCheckedChange={(blocklistEnabled) => editor.patch({ restrictions: { blocklistEnabled } })}
        />
        <SwitchRow
          label="Block disposable email domains"
          description="Reject sign-ups from known temporary email providers."
          checked={restrictions.blockDisposableEmailDomains}
          onCheckedChange={(blockDisposableEmailDomains) => editor.patch({ restrictions: { blockDisposableEmailDomains } })}
        />
        <SwitchRow
          label="Block email subaddresses"
          description="Reject addresses like `user+tag@example.com` to prevent duplicate accounts."
          checked={restrictions.blockEmailSubaddresses}
          onCheckedChange={(blockEmailSubaddresses) => editor.patch({ restrictions: { blockEmailSubaddresses } })}
        />
        {restrictions.allowlistEnabled && allowRows.length === 0 ? (
          <Alert>
            <AlertTitle>Allowlist is enabled but empty</AlertTitle>
            <AlertDescription>Only invited users will be able to sign up. Add at least one identifier or invitation.</AlertDescription>
          </Alert>
        ) : null}
        <SaveBar dirty={editor.dirty} saving={editor.saving} onSave={editor.save} onDiscard={editor.reset} />
      </SectionCard>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ListKind)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="allow">Allowlist ({allowRows.length})</TabsTrigger>
            <TabsTrigger value="block">Blocklist ({blockRows.length})</TabsTrigger>
          </TabsList>
          <Button size="sm" onClick={() => openDialog(tab)}>
            <Plus className="size-4" /> Add {tab === "allow" ? "allowed" : "blocked"} identifier
          </Button>
        </div>
        <TabsContent value="allow" className="mt-4">
          {listTable(allowRows, "allow")}
        </TabsContent>
        <TabsContent value="block" className="mt-4">
          {listTable(blockRows, "block")}
        </TabsContent>
      </Tabs>

      <Dialog
        open={dialogKind !== null}
        onOpenChange={(open) => {
          if (!open) setDialogKind(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogKind === "block" ? "Block identifier" : "Allow identifier"}</DialogTitle>
            <DialogDescription>
              {dialogKind === "block"
                ? "Sign-ups matching this identifier will be rejected."
                : "Sign-ups matching this identifier will be permitted when the allowlist is enabled."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Identifier type" htmlFor="restriction-type">
              <Select value={identifierKind} onValueChange={(value) => setIdentifierKind(value as IdentifierKind)}>
                <SelectTrigger id="restriction-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email address</SelectItem>
                  <SelectItem value="domain">Email domain</SelectItem>
                  <SelectItem value="phone">Phone number</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label={identifierKind === "domain" ? "Domain" : identifierKind === "phone" ? "Phone number" : "Email address"}
              htmlFor="restriction-identifier"
              required
              error={identifierError}
              description={
                identifierKind === "domain"
                  ? "Every user with an email at this domain will match."
                  : identifierKind === "phone"
                    ? "E.164 format, for example +15551234567."
                    : undefined
              }
            >
              <Input
                id="restriction-identifier"
                value={identifier}
                onChange={(event) => setIdentifier(event.target.value)}
                placeholder={identifierKind === "domain" ? "example.com" : identifierKind === "phone" ? "+15551234567" : "user@example.com"}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitIdentifier();
                }}
              />
            </Field>
            {parsed && parsed.identifier !== identifier.trim() ? (
              <p className="text-xs text-muted-foreground">
                Will be stored as <code>{parsed.identifier}</code>.
              </p>
            ) : null}
            {dialogKind === "allow" ? (
              <CheckboxRow
                label="Notify this identifier"
                description="Send an email or SMS with a sign-up link when the identifier is allowed. Only possible for exact addresses."
                checked={notify}
                disabled={identifierKind !== "email"}
                onCheckedChange={setNotify}
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogKind(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitIdentifier()} disabled={!parsed || adding}>
              {adding ? "Adding…" : dialogKind === "block" ? "Block identifier" : "Allow identifier"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={tab === "allow" ? "Remove allowed identifier?" : "Remove blocked identifier?"}
        description={
          <span>
            <code>{selected?.identifier}</code> will no longer be {tab === "allow" ? "allowed" : "blocked"}.
          </span>
        }
        confirmLabel="Remove"
        destructive
        loading={deleting}
        onConfirm={() => void deleteIdentifier()}
      />
    </div>
  );
}
