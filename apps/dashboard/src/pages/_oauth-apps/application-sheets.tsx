import { useEffect, useState } from "react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { Pencil, RotateCw } from "lucide-react";
import {
  CheckboxRow,
  CopyButton,
  DetailSheet,
  EndpointRow,
  Field,
  MetaChip,
  Notice,
  SecretReveal,
  StringListEditor,
  SwitchRow,
  ValidationSummary,
} from "../_config/ui";
import type { OAuthAppsController } from "./use-oauth-apps";
import { EndpointsPanel, IntegrationSnippets } from "./endpoints-panel";
import { GROUPS_CLAIM_OPTIONS, numberFrom, uniqueScopes, type AppForm } from "./model";

export function ApplicationFormSheet({ ctl }: { ctl: OAuthAppsController }) {
  const { sheetOpen, setSheetOpen, form, setForm, saving, formErrors, saveApplication } = ctl;
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!sheetOpen) setAttempted(false);
  }, [sheetOpen]);

  return (
    <DetailSheet
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      title={form.id ? "Edit OAuth application" : "Create OAuth application"}
      description="Public clients must use PKCE. Confidential clients receive a client secret."
      footer={
        <>
          <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setAttempted(true);
              if (formErrors.length === 0) void saveApplication();
            }}
            disabled={saving}
          >
            {saving ? "Saving…" : form.id ? "Save changes" : "Create application"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Short values sit two to a row: a 576px sheet should not carry a full-width input for a name. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Application name" htmlFor="oauth-app-name" required>
            <Input
              id="oauth-app-name"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="Acme Dashboard"
            />
          </Field>
          <Field label="Scopes" htmlFor="oauth-app-scopes" required description="Space-separated, usually starting with openid.">
            <Input
              id="oauth-app-scopes"
              value={form.scopes}
              onChange={(event) => setForm((current) => ({ ...current, scopes: event.target.value }))}
              className="font-data text-xs"
            />
          </Field>
        </div>
        <Field label="Redirect URIs" required description="Exact match. Native apps may use a custom scheme.">
          <StringListEditor
            values={form.redirectUris}
            onChange={(redirectUris) => setForm((current) => ({ ...current, redirectUris }))}
            placeholder="https://app.example.com/oauth/callback"
            addLabel="Add redirect URI"
            inputType="text"
          />
        </Field>
        <Field label="Post-logout redirect URIs" description="Optional. Only these URIs may receive the browser after RP-initiated logout.">
          <StringListEditor
            values={form.postLogoutRedirectUris}
            onChange={(postLogoutRedirectUris) => setForm((current) => ({ ...current, postLogoutRedirectUris }))}
            placeholder="https://app.example.com/signed-out"
            addLabel="Add post-logout URI"
            inputType="text"
          />
        </Field>
        <Field
          label="Groups claim"
          htmlFor="oauth-app-groups"
          description="What the groups claim contains when the groups scope is granted. Use it for role mapping in Authentik, Tinyauth and Grafana."
        >
          <Select
            value={form.groupsClaim}
            onValueChange={(groupsClaim) => setForm((current) => ({ ...current, groupsClaim: groupsClaim as AppForm["groupsClaim"] }))}
          >
            <SelectTrigger id="oauth-app-groups" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPS_CLAIM_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Access token (s)" htmlFor="oauth-app-access-ttl" description="60 – 86400">
            <Input
              id="oauth-app-access-ttl"
              type="number"
              min={60}
              max={86_400}
              value={form.accessTokenLifetimeSeconds}
              onChange={(event) => setForm((current) => ({ ...current, accessTokenLifetimeSeconds: numberFrom(event.target.value) }))}
            />
          </Field>
          <Field label="Refresh token (s)" htmlFor="oauth-app-refresh-ttl" description="60 – 31536000">
            <Input
              id="oauth-app-refresh-ttl"
              type="number"
              min={60}
              max={31_536_000}
              value={form.refreshTokenLifetimeSeconds}
              onChange={(event) => setForm((current) => ({ ...current, refreshTokenLifetimeSeconds: numberFrom(event.target.value) }))}
            />
          </Field>
          <Field label="ID token (s)" htmlFor="oauth-app-id-ttl" description="60 – 86400">
            <Input
              id="oauth-app-id-ttl"
              type="number"
              min={60}
              max={86_400}
              value={form.idTokenLifetimeSeconds}
              onChange={(event) => setForm((current) => ({ ...current, idTokenLifetimeSeconds: numberFrom(event.target.value) }))}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">{GROUPS_CLAIM_OPTIONS.find((option) => option.value === form.groupsClaim)?.description}</p>
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
          label="Skip consent screen (trusted app)"
          description="First-party apps get a code immediately. Otherwise the user approves the scopes once and the decision is remembered."
          checked={!form.consentScreenEnabled}
          onCheckedChange={(skipConsent) => setForm((current) => ({ ...current, consentScreenEnabled: !skipConsent }))}
        />
        <ValidationSummary errors={attempted ? formErrors : []} title="Fix these before saving" />
      </div>
    </DetailSheet>
  );
}

export function ApplicationDetailSheet({ ctl }: { ctl: OAuthAppsController }) {
  const { detail, setDetail, rotating, apiBase, issuer, discovery, settings, openEdit, rotateSecret } = ctl;

  return (
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
            {detail.consent_screen_enabled ? <MetaChip>Consent screen</MetaChip> : <MetaChip>Consent skipped</MetaChip>}
          </div>
          <div className="flex items-center justify-between gap-3 border-y border-border py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium">Client ID</p>
              <code className="block truncate font-data text-xs text-muted-foreground">{detail.client_id}</code>
            </div>
            <CopyButton value={detail.client_id} size="icon-sm" variant="outline" />
          </div>
          <EndpointsPanel issuer={issuer} discovery={discovery} />
          {issuer !== apiBase ? (
            <p className="text-xs text-muted-foreground">
              Issuer comes from the instance's public base URL (<code className="font-data text-xs">ORBITID_BASE_URL</code>),
              not from this dashboard's development proxy.
            </p>
          ) : null}
          {settings?.oidcProvider.deviceAuthorizationEnabled ? (
            <>
              <EndpointRow label="Device authorization endpoint" url={`${issuer}/oauth/device_authorization`} />
              <EndpointRow
                label="Device verification page"
                url={`${issuer}/oauth/device`}
                description="Show the user code the device receives, or open this page with it filled in."
              />
            </>
          ) : null}
          {settings?.oidcProvider.deviceAuthorizationEnabled ? (
            <Notice title="Device flow is on for this application">
              <p>
                POST <code className="font-data text-xs">client_id</code> and{" "}
                <code className="font-data text-xs">scope</code> to the device authorization endpoint, then poll the
                token endpoint with <code className="font-data text-xs">grant_type=urn:ietf:params:oauth:grant-type:device_code</code>{" "}
                every {settings.oidcProvider.deviceCodeIntervalSeconds} seconds for up to{" "}
                {Math.round(settings.oidcProvider.deviceCodeLifetimeSeconds / 60)} minutes.
              </p>
            </Notice>
          ) : null}
          {!detail.public ? (
            <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
              Client secret: <span className="font-medium text-foreground">not shown again</span>. It was displayed once
              when the application was created. Rotate the secret below to issue and show a new one.
            </p>
          ) : null}
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
              {uniqueScopes(detail.scopes).map((scope) => (
                <code key={scope} className="border border-border px-1.5 py-0.5 font-data text-xs text-muted-foreground">
                  {scope}
                </code>
              ))}
            </div>
          </div>
          {detail.post_logout_redirect_uris.length > 0 ? (
            <div>
              <p className="pb-1 text-sm font-medium">Post-logout redirect URIs</p>
              {detail.post_logout_redirect_uris.map((uri) => (
                <div key={uri} className="flex items-center justify-between gap-2 border-b border-border py-1.5 last:border-b-0">
                  <code className="truncate font-data text-xs">{uri}</code>
                  <CopyButton value={uri} size="icon-sm" />
                </div>
              ))}
            </div>
          ) : null}
          <div className="grid gap-2 border-y border-border py-2 text-xs text-muted-foreground sm:grid-cols-3">
            <p>Access token: <span className="font-data text-foreground">{detail.access_token_lifetime_seconds}s</span></p>
            <p>Refresh token: <span className="font-data text-foreground">{detail.refresh_token_lifetime_seconds}s</span></p>
            <p>ID token: <span className="font-data text-foreground">{detail.id_token_lifetime_seconds}s</span></p>
            <p className="sm:col-span-3">Groups claim: <span className="font-data text-foreground">{detail.groups_claim}</span></p>
          </div>
          <IntegrationSnippets issuer={issuer} detail={detail} discovery={discovery} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Secrets are write-only. Rotate the secret to show a new value once, then copy it into the application.
          </p>
        </div>
      ) : null}
    </DetailSheet>
  );
}

export function ApplicationSecretSheet({ ctl }: { ctl: OAuthAppsController }) {
  const { secret, setSecret } = ctl;

  return (
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
  );
}
