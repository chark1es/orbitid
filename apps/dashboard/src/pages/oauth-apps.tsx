import { useState } from "react";
import type { OAuthApplicationJSON, PaginatedList } from "@orbitid/shared";
import {
  Button,
  Input,
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
  DetailSheet,
  EmptyState,
  EndpointRow,
  ErrorAlert,
  Field,
  MetaChip,
  PageHeader,
  RuledTable,
  SecretReveal,
  StringListEditor,
  SwitchRow,
  TableSkeleton,
  ValidationSummary,
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<AppForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<OAuthApplicationJSON | null>(null);
  const [secret, setSecret] = useState<{ title: string; clientId: string; value: string | null } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [selected, setSelected] = useState<OAuthApplicationJSON | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setSheetOpen(true);
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
    setSheetOpen(true);
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
      setSheetOpen(false);
      const created = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
      const returned = ((created?.data ?? created) ?? null) as Record<string, unknown> | null;
      const clientId = typeof returned?.client_id === "string" ? returned.client_id : "";
      const secretValue = oneTimeSecret(response);
      if (!form.id) {
        setSecret({ title: `Application ${body.name} created`, clientId, value: secretValue });
      } else if (secretValue) {
        setSecret({ title: `Application ${body.name} updated`, clientId, value: secretValue });
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
      setSecret({ title: `New client secret for ${detail.name}`, clientId: detail.client_id, value: oneTimeSecret(response) });
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
        description="OrbitID as an OAuth 2.0 and OpenID Connect identity provider. Applications use the authorize, token, userinfo, and JWKS endpoints."
        badge={<MetaChip>{applications.length} {applications.length === 1 ? "application" : "applications"}</MetaChip>}
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" aria-hidden /> Create application
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      {query.isLoading ? (
        <TableSkeleton />
      ) : applications.length === 0 ? (
        <EmptyState
          title="No OAuth applications"
          description="Register a first-party or third-party application so users can sign in to it with OrbitID."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden /> Create application
            </Button>
          }
        />
      ) : (
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Application</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Redirect URIs</TableHead>
              <TableHead>PKCE</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((application) => (
              <TableRow key={application.id}>
                <TableCell className="text-sm font-medium">{application.name}</TableCell>
                <TableCell>
                  <code className="block max-w-[18rem] truncate font-data text-xs">{application.client_id}</code>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{application.public ? "Public" : "Confidential"}</TableCell>
                <TableCell className="text-right font-data text-xs">{application.redirect_uris.length}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{application.pkce_required ? "Required" : "Optional"}</TableCell>
                <TableCell className="font-data text-xs text-muted-foreground">{formatDate(application.created_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setDetail(application)} title="Details">
                      <Eye className="size-4" aria-hidden />
                      <span className="sr-only">Details for {application.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(application)} title="Edit">
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit {application.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(application)} title="Delete">
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete {application.name}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </RuledTable>
      )}

      <DetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        size="lg"
        title={form.id ? "Edit OAuth application" : "Create OAuth application"}
        description="Public clients must use PKCE. Confidential clients receive a client secret."
        footer={
          <>
            <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveApplication()} disabled={saving || formErrors.length > 0}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Create application"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Application name" htmlFor="oauth-app-name" required>
            <Input
              id="oauth-app-name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Acme Dashboard"
            />
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
            <Input
              id="oauth-app-scopes"
              value={form.scopes}
              onChange={(event) => setForm((current) => ({ ...current, scopes: event.target.value }))}
              className="font-data text-xs"
            />
          </Field>
          <SwitchRow
            label="Public client"
            description={form.id ? "Client type cannot change after creation." : "Public clients cannot keep a secret, so PKCE is mandatory."}
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
            label="Show the consent screen"
            description="Ask users to approve the requested scopes before the server issues a code."
            checked={form.consentScreenEnabled}
            onCheckedChange={(consentScreenEnabled) => setForm((current) => ({ ...current, consentScreenEnabled }))}
          />
          <ValidationSummary errors={formErrors} title="Fix these before saving" />
        </div>
      </DetailSheet>

      <DetailSheet
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        size="lg"
        title={detail?.name ?? "Application"}
        description="OpenID Connect endpoints and credentials for this application."
        footer={
          <>
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
                  <Pencil className="size-4" aria-hidden /> Edit
                </Button>
                <Button variant="destructive" onClick={() => void rotateSecret()} disabled={rotating}>
                  <RotateCw className="size-4" aria-hidden /> {rotating ? "Rotating…" : "Rotate secret"}
                </Button>
              </>
            ) : null}
          </>
        }
      >
        {detail ? (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <MetaChip>{detail.public ? "Public client" : "Confidential client"}</MetaChip>
              {detail.pkce_required ? <MetaChip>PKCE required</MetaChip> : null}
              {detail.consent_screen_enabled ? <MetaChip>Consent screen</MetaChip> : null}
            </div>
            <div className="flex items-center justify-between gap-3 border-y border-border py-2">
              <div className="min-w-0">
                <p className="text-xs font-medium">Client ID</p>
                <code className="block truncate font-data text-xs text-muted-foreground">{detail.client_id}</code>
              </div>
              <CopyButton value={detail.client_id} size="icon-sm" variant="outline" />
            </div>
            <div>
              <p className="pb-1 text-sm font-medium">Endpoints</p>
              <EndpointRow label="Discovery document" url={`${apiBase}/.well-known/openid-configuration`} />
              <EndpointRow label="Authorization endpoint" url={`${apiBase}/oauth/authorize`} />
              <EndpointRow label="Token endpoint" url={`${apiBase}/oauth/token`} />
              <EndpointRow label="UserInfo endpoint" url={`${apiBase}/oauth/userinfo`} />
              <EndpointRow label="JWKS" url={`${apiBase}/oauth/jwks`} />
            </div>
            <div>
              <p className="pb-1 text-sm font-medium">Redirect URIs</p>
              {detail.redirect_uris.map((uri) => (
                <div key={uri} className="flex items-center justify-between gap-2 border-b border-border py-1.5 last:border-b-0">
                  <code className="truncate font-data text-xs">{uri}</code>
                  <CopyButton value={uri} size="icon-sm" />
                </div>
              ))}
            </div>
            <div>
              <p className="pb-1 text-sm font-medium">Scopes</p>
              <div className="flex flex-wrap gap-1">
                {detail.scopes.split(/\s+/).filter(Boolean).map((scope) => (
                  <code key={scope} className="border border-border px-1.5 py-0.5 font-data text-xs text-muted-foreground">
                    {scope}
                  </code>
                ))}
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Secrets are write-only. Rotate the secret to show a new value once, then copy it into the application.
            </p>
          </div>
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={secret !== null}
        onOpenChange={(open) => !open && setSecret(null)}
        title={secret?.title ?? "Client credentials"}
        description="Copy the client secret now. It cannot be retrieved later."
        footer={<Button onClick={() => setSecret(null)}>Done</Button>}
      >
        {secret?.clientId ? (
          <div className="flex items-center justify-between gap-3 border-y border-border py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">Client ID</p>
              <code className="block truncate font-data text-xs text-muted-foreground">{secret.clientId}</code>
            </div>
            <CopyButton value={secret.clientId} size="icon-sm" variant="outline" />
          </div>
        ) : null}
        {secret?.value ? (
          <>
            <SecretReveal
              value={secret.value}
              warning="Store the secret in the application's secret manager. Public clients do not receive one."
            />
            <CopyButton value={secret.value} variant="outline" size="sm" label="Copy secret" />
          </>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            No client secret was returned. Public clients do not receive one.
          </p>
        )}
      </DetailSheet>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="Delete OAuth application?"
        description={
          <span>
            <code className="font-data">{selected?.name}</code> loses access and every issued grant is invalidated.
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
