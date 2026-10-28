import { useState } from "react";
import type { ApiKeyJSON, OrganizationJSON, PaginatedList, UserJSON } from "@orbitid/shared";
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
  TabsList,
  TabsTrigger,
  Textarea,
} from "@orbitid/ui";
import { Plus, Search, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "../lib/api";
import { oneTimeSecret, unwrapList } from "./_config/data";
import { errorMessage, formatDate, fromDateInput, textToList, toDateInput } from "./_config/settings";
import {
  CopyButton,
  EmptyState,
  ErrorAlert,
  Field,
  LoadingPage,
  PageHeader,
  SecretReveal,
  StatusBadge,
} from "./_config/ui";

type SubjectType = "user" | "org";
type FilterType = "all" | SubjectType;

interface SubjectChoice {
  id: string;
  label: string;
  detail?: string;
}

export default function Page() {
  const keysQuery = useApi<PaginatedList<ApiKeyJSON>>(["api_keys"], "/api_keys?limit=100");
  const keys = unwrapList<ApiKeyJSON>(keysQuery.data);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterText, setFilterText] = useState("");

  const [createOpen, setCreateOpen] = useState(false);
  const [subjectType, setSubjectType] = useState<SubjectType>("user");
  const [search, setSearch] = useState("");
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
    ["api-key-user-search", search],
    `/users?query=${encodeURIComponent(search.trim())}&limit=8&paginated=true`,
    { enabled: createOpen && subjectType === "user" && search.trim().length > 0 },
  );
  const orgSearch = useApi<PaginatedList<OrganizationJSON>>(
    ["api-key-org-search", search],
    `/organizations?query=${encodeURIComponent(search.trim())}&limit=8`,
    { enabled: createOpen && subjectType === "org" && search.trim().length > 0 },
  );

  const filteredKeys = keys.filter((key) => {
    const isOrg = key.subject.startsWith("org_");
    if (filterType === "user" && isOrg) return false;
    if (filterType === "org" && !isOrg) return false;
    if (!filterText.trim()) return true;
    const needle = filterText.trim().toLowerCase();
    return key.name.toLowerCase().includes(needle) || key.subject.toLowerCase().includes(needle) || key.prefix.toLowerCase().includes(needle);
  });

  const resetCreate = () => {
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
    <div className="space-y-6">
      <PageHeader
        title="API keys"
        description="Scoped, revocable credentials for Backend API access. Keys are shown once and stored as hashes."
        badge={<Badge variant="outline">{keys.filter((key) => !key.revoked).length} active</Badge>}
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> Create API key
          </Button>
        }
      />

      {keysQuery.error ? <ErrorAlert error={errorMessage(keysQuery.error)} onRetry={() => void keysQuery.refetch()} /> : null}

      <div className="flex flex-col gap-2 rounded-xl border bg-card p-3 sm:flex-row sm:items-center">
        <Select value={filterType} onValueChange={(value) => setFilterType(value as FilterType)}>
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All subjects</SelectItem>
            <SelectItem value="user">Users</SelectItem>
            <SelectItem value="org">Organizations</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="Filter by name, subject, or prefix"
            className="pl-8"
          />
        </div>
      </div>

      {keysQuery.isLoading ? (
        <LoadingPage rows={2} />
      ) : filteredKeys.length === 0 ? (
        <EmptyState
          title={keys.length === 0 ? "No API keys" : "No matching API keys"}
          description={keys.length === 0 ? "Create a key for a user or organization to call the Backend API." : "Adjust the filters above."}
          action={
            keys.length === 0 ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" /> Create API key
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredKeys.map((key) => {
                const expired = Boolean(key.expiration && key.expiration < Date.now());
                return (
                  <TableRow key={key.id}>
                    <TableCell>
                      <div className="space-y-0.5">
                        <p className="font-medium">{key.name}</p>
                        <code className="text-xs text-muted-foreground">{key.prefix}…</code>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={key.subject.startsWith("org_") ? "secondary" : "outline"}>
                        {key.subject.startsWith("org_") ? "Organization" : "User"}
                      </Badge>
                      <p className="mt-1 max-w-[16rem] truncate font-mono text-xs text-muted-foreground">{key.subject}</p>
                    </TableCell>
                    <TableCell>
                      <div className="flex max-w-xs flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} variant="outline" className="font-mono text-[10px]">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={key.revoked ? "revoked" : expired ? "expired" : "active"} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(key.expiration)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(key.last_used_at)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        disabled={key.revoked}
                        onClick={() => setRevoking(key)}
                        title="Revoke"
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Revoke</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="size-4" />
          <h2 className="text-sm font-semibold">Verify a key</h2>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            autoComplete="off"
            value={verifySecret}
            onChange={(event) => setVerifySecret(event.target.value)}
            placeholder="ak_live_…"
            className="font-mono"
          />
          <Button variant="outline" onClick={() => void verifyKey()} disabled={verifying || !verifySecret.trim()}>
            {verifying ? "Verifying…" : "Verify key"}
          </Button>
        </div>
        {verifyResult !== null ? (
          <pre className="mt-3 max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
            {JSON.stringify(verifyResult, null, 2)}
          </pre>
        ) : null}
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreate();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>A key inherits the subject's identity and is limited to the selected scopes.</DialogDescription>
          </DialogHeader>
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
                <TabsTrigger value="org">Organization</TabsTrigger>
              </TabsList>
            </Tabs>
            {choice ? (
              <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{choice.label}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{choice.id}</p>
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
                ) : (subjectType === "user" ? userSearch.isLoading : orgSearch.isLoading) ? (
                  <p className="text-xs text-muted-foreground">Searching…</p>
                ) : subjectResults.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No matches.</p>
                ) : (
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border p-1">
                    {subjectResults.map((result) => (
                      <button
                        key={result.id}
                        type="button"
                        className="flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-accent"
                        onClick={() => setChoice(result)}
                      >
                        <span className="truncate text-sm font-medium">{result.label}</span>
                        <span className="truncate font-mono text-xs text-muted-foreground">{result.detail ?? result.id}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="api-key-name" required>
                <Input id="api-key-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production backend" />
              </Field>
              <Field label="Expiration" htmlFor="api-key-expiration" description="Leave blank for no expiry.">
                <Input id="api-key-expiration" type="date" min={toDateInput(Date.now())} value={expiration} onChange={(event) => setExpiration(event.target.value)} />
              </Field>
            </div>
            <Field label="Description" htmlFor="api-key-description">
              <Input id="api-key-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Used by the billing service" />
            </Field>
            <Field label="Scopes" htmlFor="api-key-scopes" required description="Comma- or newline-separated scope names.">
              <Textarea id="api-key-scopes" rows={3} value={scopesText} onChange={(event) => setScopesText(event.target.value)} className="font-mono text-xs" />
            </Field>
            {createErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {createErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void createKey()} disabled={creating || createErrors.length > 0}>
              {creating ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>Copy “{revealedName}” now. The secret will not be shown again.</DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTitle>Store this secret securely</AlertTitle>
            <AlertDescription>Only a hash is stored server-side. You cannot retrieve it later.</AlertDescription>
          </Alert>
          {revealed ? (
            <div className="space-y-2">
              <SecretReveal value={revealed} />
              <CopyButton value={revealed} variant="outline" label="Copy secret" size="sm" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The server did not return a secret. Revoke this key and create it again.</p>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            setRevokeReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              <code>{revoking?.name}</code> will stop working immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <Field label="Reason (optional)" htmlFor="revoke-reason">
            <Input id="revoke-reason" value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} placeholder="Rotated by security team" />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)} disabled={revokeBusy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void revokeKey()} disabled={revokeBusy}>
              {revokeBusy ? "Revoking…" : "Revoke key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
