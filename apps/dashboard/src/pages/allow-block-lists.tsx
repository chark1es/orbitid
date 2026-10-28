import { useState } from "react";
import type { AllowlistIdentifierJSON, BlocklistIdentifierJSON, PaginatedList } from "@orbitid/shared";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { errorMessage, formatDate, normalizeRestrictionIdentifier } from "./_config/settings";
import {
  CheckboxRow,
  ConfirmDialog,
  DetailSheet,
  EmptyState,
  ErrorAlert,
  Field,
  LoadingPage,
  MetaChip,
  PageHeader,
  RuledTable,
  SaveBar,
  SettingsSection,
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
  const [sheetKind, setSheetKind] = useState<ListKind | null>(null);
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

  const addMutation = useApiMutation<Record<string, unknown>>("POST", sheetKind === "block" ? "/blocklist_identifiers" : "/allowlist_identifiers", {
    invalidate: sheetKind === "block" ? [[...fetchers.block.key]] : [[...fetchers.allow.key]],
    onSuccess: () => {
      toast.success(sheetKind === "block" ? "Identifier blocked" : "Identifier allowed");
      setSheetKind(null);
      setIdentifier("");
      setNotify(false);
    },
  });

  if (editor.isLoading) return <LoadingPage rows={3} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Allowlist & blocklist" description="Control who can sign up." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const restrictions = settings.restrictions;
  const parsed = normalizeRestrictionIdentifier(identifierKind, identifier);
  const identifierError = identifier.trim() && !parsed ? `Enter a valid ${identifierKind === "domain" ? "domain" : identifierKind}.` : null;

  const openSheet = (kind: ListKind) => {
    setSheetKind(kind);
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
      if (sheetKind === "allow") body.notify = notify;
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
      toast.success(tab === "allow" ? "Identifier removed from the allowlist" : "Identifier removed from the blocklist");
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
          title={kind === "allow" ? "No allowed identifiers" : "No blocked identifiers"}
          description={
            kind === "allow"
              ? "With the allowlist on, only these emails, domains, and phone numbers can sign up. Add one, or send an invitation instead."
              : "Blocked identifiers are rejected at sign-up even when the allowlist is off."
          }
          action={
            <Button size="sm" onClick={() => openSheet(kind)}>
              <Plus className="size-4" aria-hidden /> Add identifier
            </Button>
          }
        />
      );
    }
    return (
      <RuledTable>
        <TableHeader>
          <TableRow>
            <TableHead>Identifier</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Added</TableHead>
            <TableHead className="w-16 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-data text-xs">{row.identifier}</TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.identifier_type.replace(/_/g, " ")}</TableCell>
              <TableCell className="font-data text-xs text-muted-foreground">{formatDate(row.created_at)}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(row)} title="Remove">
                  <Trash2 className="size-4" aria-hidden />
                  <span className="sr-only">Remove {row.identifier}</span>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </RuledTable>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Allowlist & blocklist"
        description="Gate sign-ups by exact email address, an entire email domain, or a phone number."
        badge={
          <MetaChip>
            {restrictions.allowlistEnabled && restrictions.blocklistEnabled
              ? "Both lists on"
              : restrictions.allowlistEnabled
                ? "Allowlist on"
                : restrictions.blocklistEnabled
                  ? "Blocklist on"
                  : "Both lists off"}
          </MetaChip>
        }
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection title="Enforcement" description="These switches apply to sign-up after you save them.">
        <SwitchRow
          label="Enable the allowlist"
          description="Only allowlisted identifiers and users with a valid invitation may sign up."
          checked={restrictions.allowlistEnabled}
          onCheckedChange={(allowlistEnabled) => editor.patch({ restrictions: { allowlistEnabled } })}
        />
        <SwitchRow
          label="Enable the blocklist"
          description="Blocked identifiers are rejected whether or not the allowlist is on."
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
          description="Reject addresses like user+tag@example.com to prevent duplicate accounts."
          checked={restrictions.blockEmailSubaddresses}
          onCheckedChange={(blockEmailSubaddresses) => editor.patch({ restrictions: { blockEmailSubaddresses } })}
        />
        {restrictions.allowlistEnabled && allowRows.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            The allowlist is on but empty, so only invited users can sign up. Add an identifier or send invitations.
          </p>
        ) : null}
        <SaveBar
          dirty={editor.dirty}
          saving={editor.saving}
          error={editor.saveError}
          onSave={editor.save}
          onDiscard={editor.reset}
        />
      </SettingsSection>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ListKind)}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
          <TabsList>
            <TabsTrigger value="allow">Allowlist ({allowRows.length})</TabsTrigger>
            <TabsTrigger value="block">Blocklist ({blockRows.length})</TabsTrigger>
          </TabsList>
          <Button size="sm" onClick={() => openSheet(tab)}>
            <Plus className="size-4" aria-hidden /> Add {tab === "allow" ? "allowed" : "blocked"} identifier
          </Button>
        </div>
        <TabsContent value="allow" className="mt-4">
          {listTable(allowRows, "allow")}
        </TabsContent>
        <TabsContent value="block" className="mt-4">
          {listTable(blockRows, "block")}
        </TabsContent>
      </Tabs>

      <DetailSheet
        open={sheetKind !== null}
        onOpenChange={(open) => {
          if (!open) setSheetKind(null);
        }}
        title={sheetKind === "block" ? "Block identifier" : "Allow identifier"}
        description={
          sheetKind === "block"
            ? "Sign-ups that match this identifier are rejected."
            : "Sign-ups that match this identifier are permitted while the allowlist is on."
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setSheetKind(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitIdentifier()} disabled={!parsed || adding}>
              {adding ? "Adding…" : sheetKind === "block" ? "Block identifier" : "Allow identifier"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
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
                ? "Every user with an email at this domain matches."
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
              className="font-data text-xs"
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitIdentifier();
              }}
            />
          </Field>
          {parsed && parsed.identifier !== identifier.trim() ? (
            <p className="text-xs text-muted-foreground">
              Stored as <code className="font-data">{parsed.identifier}</code>.
            </p>
          ) : null}
          {sheetKind === "allow" ? (
            <CheckboxRow
              label="Notify this identifier"
              description="Send a sign-up link when the identifier is allowed. Works for exact email addresses only."
              checked={notify}
              disabled={identifierKind !== "email"}
              onCheckedChange={setNotify}
            />
          ) : null}
        </div>
      </DetailSheet>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={tab === "allow" ? "Remove allowed identifier?" : "Remove blocked identifier?"}
        description={
          <span>
            <code className="font-data">{selected?.identifier}</code> will no longer be {tab === "allow" ? "allowed" : "blocked"}.
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
