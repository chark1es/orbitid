import { useState } from "react";
import type { OAuthApplicationJSON, PaginatedList } from "@orbitid/shared";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orbitid/ui";
import { Eye, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, getApiUrl, useApi } from "../lib/api";
import { oneTimeSecret, unwrapList } from "./_config/data";
import { errorMessage, formatDate, isHttpUrl } from "./_config/settings";
import {
  CheckboxRow,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  EndpointRow,
  ErrorAlert,
  Field,
  PageHeader,
  SecretReveal,
  StringListEditor,
  SwitchRow,
  TableSkeleton,
} from "./_config/ui";

interface AppForm {
  id?: string;
  name: string;
  redirectUris: string[];
  scopes: string;
  publicClient: boolean;
  pkceRequired: boolean;
  consentScreenEnabled: boolean;
}

const EMPTY_FORM: AppForm = {
  name: "",
  redirectUris: [""],
  scopes: "openid profile email",
  publicClient: true,
  pkceRequired: true,
  consentScreenEnabled: true,
};

export default function Page() {
  const apiBase = getApiUrl();
  const query = useApi<PaginatedList<OAuthApplicationJSON>>(["oauth_applications"], "/oauth_applications?limit=100");
  const applications = unwrapList<OAuthApplicationJSON>(query.data);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AppForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<OAuthApplicationJSON | null>(null);
  const [secret, setSecret] = useState<{ title: string; clientId: string; value: string | null } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [selected, setSelected] = useState<OAuthApplicationJSON | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (application: OAuthApplicationJSON) => {
    setForm({
      id: application.id,
      name: application.name,
      redirectUris: application.redirect_uris.length > 0 ? application.redirect_uris : [""],
      scopes: application.scopes,
      publicClient: application.public,
      pkceRequired: application.pkce_required,
      consentScreenEnabled: application.consent_screen_enabled,
    });
    setDialogOpen(true);
  };

  const uris = form.redirectUris.map((uri) => uri.trim()).filter(Boolean);
  const formErrors: string[] = [];
  if (!form.name.trim()) formErrors.push("Application name is required.");
  if (uris.length === 0) formErrors.push("Add at least one redirect URI.");
  if (uris.some((uri) => !isHttpUrl(uri))) formErrors.push("Every redirect URI must be an absolute http(s) URL.");
  if (form.publicClient && !form.pkceRequired) formErrors.push("Public clients must require PKCE (S256).");
  if (!form.scopes.trim()) formErrors.push("At least one scope is required.");

  const saveApplication = async () => {
    if (formErrors.length > 0) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        redirect_uris: uris,
        scopes: form.scopes.trim(),
        pkce_required: form.pkceRequired,
        consent_screen_enabled: form.consentScreenEnabled,
      };
      if (!form.id) body.public = form.publicClient;
      const response = await api<unknown>(form.id ? "PATCH" : "POST", form.id ? `/oauth_applications/${form.id}` : "/oauth_applications", body);
      await query.refetch();
      setDialogOpen(false);
      const created = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
      const returned = ((created?.data ?? created) ?? null) as Record<string, unknown> | null;
      const clientId = typeof returned?.client_id === "string" ? returned.client_id : "";
      const secretValue = oneTimeSecret(response);
      if (!form.id) {
        setSecret({ title: `Application “${body.name}” created`, clientId, value: secretValue });
      } else if (secretValue) {
        setSecret({ title: `Application “${body.name}” updated`, clientId, value: secretValue });
      }
      toast.success(form.id ? "OAuth application updated" : "OAuth application created");
    } catch (error) {
      toast.error("Could not save OAuth application", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const rotateSecret = async () => {
    if (!detail) return;
    setRotating(true);
    try {
      const response = await api<unknown>("POST", `/oauth_applications/${detail.id}/rotate_secret`);
      setSecret({ title: `New client secret for “${detail.name}”`, clientId: detail.client_id, value: oneTimeSecret(response) });
      await query.refetch();
      toast.success("Client secret rotated");
    } catch (error) {
      toast.error("Could not rotate client secret", { description: errorMessage(error) });
    } finally {
      setRotating(false);
    }
  };

  const deleteApplication = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await api("DELETE", `/oauth_applications/${selected.id}`);
      await query.refetch();
      if (detail?.id === selected.id) setDetail(null);
      toast.success("OAuth application deleted");
      setSelected(null);
    } catch (error) {
      toast.error("Could not delete application", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="OAuth applications"
        description="OrbitID as an OAuth 2.0 / OpenID Connect identity provider. Applications use the authorize, token, userinfo, and JWKS endpoints."
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> Create application
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      {query.isLoading ? (
        <TableSkeleton />
      ) : applications.length === 0 ? (
        <EmptyState
          title="No OAuth applications"
          description="Register a first-party or third-party application to let users sign in with OrbitID."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" /> Create application
            </Button>
          }
        />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Application</TableHead>
                <TableHead>Client ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Redirect URIs</TableHead>
                <TableHead>PKCE</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((application) => (
                <TableRow key={application.id}>
                  <TableCell className="font-medium">{application.name}</TableCell>
                  <TableCell>
                    <code className="text-xs">{application.client_id}</code>
                  </TableCell>
                  <TableCell>
                    <Badge variant={application.public ? "secondary" : "outline"}>{application.public ? "Public" : "Confidential"}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {application.redirect_uris.length} configured
                  </TableCell>
                  <TableCell>{application.pkce_required ? <Badge variant="outline">Required</Badge> : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDate(application.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => setDetail(application)} title="Details">
                        <Eye className="size-4" />
                        <span className="sr-only">Details</span>
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => openEdit(application)} title="Edit">
                        <Pencil className="size-4" />
                        <span className="sr-only">Edit</span>
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(application)} title="Delete">
                        <Trash2 className="size-4" />
                        <span className="sr-only">Delete</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit OAuth application" : "Create OAuth application"}</DialogTitle>
            <DialogDescription>Public clients must use PKCE. Confidential clients receive a client secret.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Application name" htmlFor="oauth-app-name" required>
              <Input id="oauth-app-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Acme Dashboard" />
            </Field>
            <Field label="Redirect URIs" required description="Exact match. Native apps may use a custom scheme.">
              <StringListEditor
                values={form.redirectUris}
                onChange={(redirectUris) => setForm((current) => ({ ...current, redirectUris }))}
                placeholder="https://app.example.com/oauth/callback"
                addLabel="Add redirect URI"
                inputType="text"
              />
            </Field>
            <Field label="Scopes" htmlFor="oauth-app-scopes" required description="Space-separated scopes, usually starting with openid.">
              <Input id="oauth-app-scopes" value={form.scopes} onChange={(event) => setForm((current) => ({ ...current, scopes: event.target.value }))} className="font-mono" />
            </Field>
            <SwitchRow
              label="Public client"
              description={form.id ? "Client type cannot be changed after creation." : "Public clients cannot keep a secret; PKCE is mandatory."}
              checked={form.publicClient}
              disabled={Boolean(form.id)}
              onCheckedChange={(publicClient) => setForm((current) => ({ ...current, publicClient, pkceRequired: publicClient ? true : current.pkceRequired }))}
            />
            <CheckboxRow
              label="Require PKCE (S256)"
              checked={form.pkceRequired}
              disabled={form.publicClient}
              onCheckedChange={(pkceRequired) => setForm((current) => ({ ...current, pkceRequired }))}
            />
            <CheckboxRow
              label="Show consent screen"
              description="Ask users to approve the requested scopes before issuing a code."
              checked={form.consentScreenEnabled}
              onCheckedChange={(consentScreenEnabled) => setForm((current) => ({ ...current, consentScreenEnabled }))}
            />
            {formErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {formErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveApplication()} disabled={saving || formErrors.length > 0}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Create application"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{detail?.name}</SheetTitle>
            <SheetDescription>OpenID Connect endpoints and credentials for this application.</SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="space-y-4 px-4 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={detail.public ? "secondary" : "outline"}>{detail.public ? "Public client" : "Confidential client"}</Badge>
                {detail.pkce_required ? <Badge variant="outline">PKCE required</Badge> : null}
                {detail.consent_screen_enabled ? <Badge variant="outline">Consent screen</Badge> : null}
              </div>
              <div className="rounded-lg border px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium">Client ID</p>
                    <code className="block truncate text-xs text-muted-foreground">{detail.client_id}</code>
                  </div>
                  <CopyButton value={detail.client_id} size="icon-sm" variant="outline" />
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Endpoints</p>
                <EndpointRow label="Discovery document" url={`${apiBase}/.well-known/openid-configuration`} />
                <EndpointRow label="Authorization endpoint" url={`${apiBase}/oauth/authorize`} />
                <EndpointRow label="Token endpoint" url={`${apiBase}/oauth/token`} />
                <EndpointRow label="UserInfo endpoint" url={`${apiBase}/oauth/userinfo`} />
                <EndpointRow label="JWKS" url={`${apiBase}/oauth/jwks`} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Redirect URIs</p>
                {detail.redirect_uris.map((uri) => (
                  <div key={uri} className="flex items-center justify-between gap-2 rounded-md border px-2 py-1">
                    <code className="truncate text-xs">{uri}</code>
                    <CopyButton value={uri} size="icon-xs" />
                  </div>
                ))}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">Scopes</p>
                <div className="flex flex-wrap gap-1">
                  {detail.scopes.split(/\s+/).filter(Boolean).map((scope) => (
                    <Badge key={scope} variant="secondary" className="font-mono text-[10px]">
                      {scope}
                    </Badge>
                  ))}
                </div>
              </div>
              <Alert>
                <AlertTitle>Client secret</AlertTitle>
                <AlertDescription>
                  Secrets are write-only. Rotate the secret to reveal a new value once.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          <SheetFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
            {detail ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => {
                    const editing = detail;
                    setDetail(null);
                    openEdit(editing);
                  }}
                >
                  <Pencil className="size-4" /> Edit
                </Button>
                <Button variant="destructive" onClick={() => void rotateSecret()} disabled={rotating}>
                  <RotateCw className="size-4" /> {rotating ? "Rotating…" : "Rotate secret"}
                </Button>
              </>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog open={secret !== null} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{secret?.title ?? "Client credentials"}</DialogTitle>
            <DialogDescription>Copy the client secret now. It is not retrievable later.</DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTitle>One-time client secret</AlertTitle>
            <AlertDescription>Store it in the application's secret manager.</AlertDescription>
          </Alert>
          {secret?.clientId ? (
            <div className="rounded-lg border px-3 py-2">
              <p className="text-xs font-medium">Client ID</p>
              <code className="text-xs text-muted-foreground">{secret.clientId}</code>
            </div>
          ) : null}
          {secret?.value ? (
            <div className="space-y-2">
              <SecretReveal value={secret.value} />
              <CopyButton value={secret.value} variant="outline" size="sm" label="Copy secret" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No client secret was returned. Public clients do not receive one.</p>
          )}
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="Delete OAuth application?"
        description={
          <span>
            <code>{selected?.name}</code> will lose access and all issued grants will be invalidated.
          </span>
        }
        confirmLabel="Delete application"
        destructive
        loading={deleting}
        onConfirm={() => void deleteApplication()}
      />
    </div>
  );
}
