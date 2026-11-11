import { useState } from "react";
import { Page as PageLayout } from "../components/shared/page";
import type { ApiKeyJSON, OrganizationJSON, PaginatedList, UserJSON } from "@orbitid/shared";
import {
  Button,
  Input,
  SearchInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@orbitid/ui";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, apiAllPages, useApi } from "../lib/api";
import { useShowOrganizations } from "../lib/features";
import { useDebounced } from "../lib/hooks";
import { useTableState } from "../lib/use-table-state";
import { TablePagination } from "../components/shared/table-pagination";
import { oneTimeSecret, unwrapList } from "./_config/data";
import { errorMessage, fromDateInput, textToList, toDateInput } from "./_config/settings";
import {
  CopyButton,
  DetailSheet,
  EmptyState,
  ErrorAlert,
  Field,
  MetaChip,
  PageHeader,
  SecretReveal,
  TableSkeleton,
  ValidationSummary,
} from "./_config/ui";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { ApiKeysTable } from "./_api-keys/keys-table";

type SubjectType = "user" | "org";
type FilterType = "all" | SubjectType;

interface SubjectChoice {
  id: string;
  label: string;
  detail?: string;
}

export default function Page() {
  const table = useTableState({ limit: 20, orderBy: "-created_at" });
  const keysPath = `/api_keys?order_by=${encodeURIComponent(table.orderBy)}`;
  const keysQuery = useApi<PaginatedList<ApiKeyJSON>>(["api_keys", table.orderBy], keysPath, {
    queryFn: ({ signal }) => apiAllPages<ApiKeyJSON>(keysPath, { signal }),
  });
  const keys = unwrapList<ApiKeyJSON>(keysQuery.data);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterText, setFilterText] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [createAttempted, setCreateAttempted] = useState(false);
  const [subjectType, setSubjectType] = useState<SubjectType>("user");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 250);
  const showOrganizations = useShowOrganizations();
  const [choice, setChoice] = useState<SubjectChoice | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scopesText, setScopesText] = useState("read:users");
  const [expiration, setExpiration] = useState("");
  const [creating, setCreating] = useState(false);

  const [revealed, setRevealed] = useState<string | null>(null);
  const [revealedName, setRevealedName] = useState("");
  const [revoking, setRevoking] = useState<ApiKeyJSON | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);

  const [verifySecret, setVerifySecret] = useState("");
  const [verifyResult, setVerifyResult] = useState<unknown>(null);
  const [verifying, setVerifying] = useState(false);

  const userSearch = useApi<PaginatedList<UserJSON>>(
    ["api-key-user-search", debouncedSearch],
    `/users?query=${encodeURIComponent(debouncedSearch)}&limit=8&paginated=true`,
    { enabled: createOpen && subjectType === "user" && debouncedSearch.length > 0 },
  );
  const orgSearch = useApi<PaginatedList<OrganizationJSON>>(
    ["api-key-org-search", debouncedSearch],
    `/organizations?query=${encodeURIComponent(debouncedSearch)}&limit=8`,
    { enabled: createOpen && showOrganizations && subjectType === "org" && debouncedSearch.length > 0 },
  );

  const filteredKeys = keys.filter((key) => {
    const isOrg = key.subject.startsWith("org_");
    if (filterType === "user" && isOrg) return false;
    if (filterType === "org" && !isOrg) return false;
    if (!filterText.trim()) return true;
    const needle = filterText.trim().toLowerCase();
    return key.name.toLowerCase().includes(needle) || key.subject.toLowerCase().includes(needle) || key.prefix.toLowerCase().includes(needle);
  });
  const totalPages = Math.max(1, Math.ceil(filteredKeys.length / table.limit));
  const currentPage = Math.min(table.page, totalPages);
  const pageKeys = filteredKeys.slice((currentPage - 1) * table.limit, currentPage * table.limit);

  const resetCreate = () => {
    setCreateAttempted(false);
    setChoice(null);
    setSearch("");
    setName("");
    setDescription("");
    setScopesText("read:users");
    setExpiration("");
    setSubjectType("user");
  };

  const createErrors: string[] = [];
  if (!choice) createErrors.push("Choose a user or organization subject.");
  if (!name.trim()) createErrors.push("Key name is required.");
  if (textToList(scopesText).length === 0) createErrors.push("Add at least one scope.");
  const expirationMs = expiration ? fromDateInput(expiration) : null;
  if (expiration && !expirationMs) createErrors.push("Expiration date is invalid.");
  if (expirationMs && expirationMs <= Date.now()) createErrors.push("Expiration must be in the future.");

  const createKey = async () => {
    if (!choice || createErrors.length > 0) return;
    setCreating(true);
    try {
      const response = await api<unknown>("POST", "/api_keys", {
        subject: choice.id,
        name: name.trim(),
        description: description.trim() || null,
        scopes: textToList(scopesText),
        seconds_until_expiration: expirationMs ? Math.max(1, Math.ceil((expirationMs - Date.now()) / 1000)) : null,
      });
      const secret = oneTimeSecret(response) ?? (typeof response === "string" ? response : null);
      setRevealed(secret ?? "");
      setRevealedName(name.trim());
      setCreateOpen(false);
      resetCreate();
      await keysQuery.refetch();
      toast.success("API key created");
    } catch (error) {
      toast.error("Could not create API key", { description: errorMessage(error) });
    } finally {
      setCreating(false);
    }
  };

  const revokeKey = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await api("POST", `/api_keys/${revoking.id}/revoke`, { revocation_reason: revokeReason.trim() || null });
      await keysQuery.refetch();
      toast.success("API key revoked");
      setRevoking(null);
      setRevokeReason("");
    } catch (error) {
      toast.error("Could not revoke API key", { description: errorMessage(error) });
    } finally {
      setRevokeBusy(false);
    }
  };

  const verifyKey = async () => {
    if (!verifySecret.trim()) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api<unknown>("POST", "/api_keys/verify", { secret: verifySecret.trim() });
      setVerifyResult(result);
      toast.success("Key verified");
    } catch (error) {
      setVerifyResult({ error: errorMessage(error) });
      toast.error("Key verification failed", { description: errorMessage(error) });
    } finally {
      setVerifying(false);
    }
  };

  const subjectResults: SubjectChoice[] =
    subjectType === "user"
      ? unwrapList<UserJSON>(userSearch.data).map((user) => ({
          id: user.id,
          label:
            [user.first_name, user.last_name].filter(Boolean).join(" ") ||
            user.username ||
            user.email_addresses[0]?.email_address ||
            user.id,
          detail: user.email_addresses[0]?.email_address,
        }))
      : unwrapList<OrganizationJSON>(orgSearch.data).map((organization) => ({
          id: organization.id,
          label: organization.name,
          detail: organization.slug,
        }));

  return (
    <PageLayout>
      <PageHeader
        title="API keys"
        description="Scoped, revocable credentials for Backend API access. The secret is shown once and stored as a hash."
        badge={<MetaChip>{keys.filter((key) => !key.revoked).length} active</MetaChip>}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> Create API key
          </Button>
        }
      />

      {keysQuery.error ? <ErrorAlert error={errorMessage(keysQuery.error)} onRetry={() => void keysQuery.refetch()} /> : null}

      <div className="flex flex-col gap-2 border-y border-border py-3 sm:flex-row sm:items-center">
        <Select value={filterType} onValueChange={(value) => setFilterType(value as FilterType)}>
          <SelectTrigger className="w-full sm:w-44" aria-label="Filter by subject type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All subjects</SelectItem>
            <SelectItem value="user">Users</SelectItem>
            {showOrganizations || filterType === "org" ? <SelectItem value="org">Organizations</SelectItem> : null}
          </SelectContent>
        </Select>
        <SearchInput
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="Filter by name, subject, or prefix"
          aria-label="Filter API keys"
          className="flex-1"
        />
      </div>

      {keysQuery.isLoading ? (
        <TableSkeleton />
      ) : filteredKeys.length === 0 ? (
        <EmptyState
          compact
          title={keys.length === 0 ? "No API keys" : "No matching API keys"}
          description={
            keys.length === 0
              ? "Create a key for a user or organization to call the Backend API from a server."
              : "Change the filters to see other keys."
          }
          action={
            keys.length === 0 ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden /> Create API key
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ApiKeysTable keys={pageKeys} onRevoke={setRevoking} />
      )}

      {keys.length > 0 ? (
        <TablePagination
          page={currentPage}
          limit={table.limit}
          total={filteredKeys.length}
          onPageChange={table.setPage}
          onLimitChange={table.setLimit}
          disabled={keysQuery.isFetching}
        />
      ) : null}

      <section className="grid gap-4 border-t border-border pt-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-10">
        <div className="space-y-1">
          <h2 className="text-sm font-heading">Verify a key</h2>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">Check that a secret is valid and see the scopes the server returns.</p>
        </div>
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              autoComplete="off"
              value={verifySecret}
              onChange={(event) => setVerifySecret(event.target.value)}
              placeholder="ak_live_…"
              className="font-data text-xs"
              aria-label="Secret to verify"
            />
            <Button variant="outline" onClick={() => void verifyKey()} disabled={verifying || !verifySecret.trim()}>
              {verifying ? "Verifying…" : "Verify key"}
            </Button>
          </div>
          {verifyResult !== null ? (
            <pre className="max-h-64 overflow-auto border border-border bg-muted/40 p-3 font-data text-xs leading-relaxed">
              {JSON.stringify(verifyResult, null, 2)}
            </pre>
          ) : null}
        </div>
      </section>

      <DetailSheet
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreate();
        }}
        title="Create API key"
        description="A key inherits its subject's identity and is limited to the selected scopes."
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setCreateAttempted(true);
                if (createErrors.length === 0) void createKey();
              }}
              disabled={creating}
            >
              {creating ? "Creating…" : "Create key"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Tabs
            value={subjectType}
            onValueChange={(value) => {
              setSubjectType(value as SubjectType);
              setChoice(null);
              setSearch("");
            }}
          >
            <TabsList>
              <TabsTrigger value="user">User</TabsTrigger>
              {showOrganizations ? <TabsTrigger value="org">Organization</TabsTrigger> : null}
            </TabsList>
          </Tabs>
          {choice ? (
            <div className="flex items-center justify-between gap-3 border-y border-border py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{choice.label}</p>
                <p className="truncate font-data text-xs text-muted-foreground">{choice.id}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setChoice(null)}>
                Change
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Field label={`Search ${subjectType === "user" ? "users" : "organizations"}`} htmlFor="api-key-subject-search">
                <Input
                  id="api-key-subject-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={subjectType === "user" ? "Name, email, or user ID" : "Organization name or slug"}
                />
              </Field>
              {search.trim().length === 0 ? (
                <p className="text-xs text-muted-foreground">Type at least one character to search.</p>
              ) : search.trim() !== debouncedSearch || (subjectType === "user" ? userSearch.isLoading : orgSearch.isLoading) ? (
                <p className="text-xs text-muted-foreground">Searching…</p>
              ) : subjectResults.length === 0 ? (
                <p className="text-xs text-muted-foreground">No matches.</p>
              ) : (
                <div className="max-h-44 space-y-1 overflow-y-auto border border-border p-1">
                  {subjectResults.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      className="flex w-full flex-col px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      onClick={() => setChoice(result)}
                    >
                      <span className="truncate text-sm font-medium">{result.label}</span>
                      <span className="truncate font-data text-xs text-muted-foreground">{result.detail ?? result.id}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="api-key-name" required>
              <Input id="api-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production backend" />
            </Field>
            <Field label="Expiration" htmlFor="api-key-expiration" description="Leave blank for no expiry.">
              <Input
                id="api-key-expiration"
                type="date"
                min={toDateInput(Date.now())}
                value={expiration}
                onChange={(event) => setExpiration(event.target.value)}
                className="font-data text-xs"
              />
            </Field>
          </div>
          <Field label="Description" htmlFor="api-key-description">
            <Input
              id="api-key-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Used by the reporting service"
            />
          </Field>
          <Field label="Scopes" htmlFor="api-key-scopes" required description="Comma- or newline-separated scope names.">
            <Textarea
              id="api-key-scopes"
              rows={3}
              value={scopesText}
              onChange={(event) => setScopesText(event.target.value)}
              className="font-data text-xs"
            />
          </Field>
          <ValidationSummary errors={createAttempted ? createErrors : []} title="Fix these before creating the key" />
        </div>
      </DetailSheet>

      <DetailSheet
        open={revealed !== null}
        onOpenChange={(open) => !open && setRevealed(null)}
        title="API key created"
        description={`Copy ${revealedName || "this key"} now. The secret is not shown again.`}
        footer={<Button onClick={() => setRevealed(null)}>Done</Button>}
      >
        {revealed ? (
          <SecretReveal
            value={revealed}
            warning="Only a hash is stored on the server. Store the secret in your deployment's secret manager before you close this panel."
          />
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            The server did not return a secret. Revoke this key and create it again.
          </p>
        )}
        {revealed ? <CopyButton value={revealed} variant="outline" label="Copy secret" size="sm" /> : null}
      </DetailSheet>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            setRevokeReason("");
          }
        }}
        title="Revoke API key"
        description={
          <>
            <code className="font-data">{revoking?.name}</code> stops working immediately. This cannot be undone.
          </>
        }
        confirmLabel="Revoke key"
        destructive
        pending={revokeBusy}
        onConfirm={() => void revokeKey()}
      >
        <Field label="Reason (optional)" htmlFor="revoke-reason">
          <Input
            id="revoke-reason"
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            placeholder="Rotated by the security team"
          />
        </Field>
      </ConfirmDialog>
    </PageLayout>
  );
}
