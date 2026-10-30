import { Button, Input } from "@orbitid/ui";
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

export function ApplicationFormSheet({ ctl }: { ctl: OAuthAppsController }) {
  const { sheetOpen, setSheetOpen, form, setForm, saving, formErrors, saveApplication } = ctl;

  return (
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
  );
}

export function ApplicationDetailSheet({ ctl }: { ctl: OAuthAppsController }) {
  const { detail, setDetail, rotating, apiBase, settings, openEdit, rotateSecret } = ctl;

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
            {settings?.oidcProvider.deviceAuthorizationEnabled ? (
              <>
                <EndpointRow label="Device authorization endpoint" url={`${apiBase}/oauth/device_authorization`} />
                <EndpointRow
                  label="Device verification page"
                  url={`${apiBase}/oauth/device`}
                  description="Show the user code the device receives, or open this page with it filled in."
                />
              </>
            ) : null}
          </div>
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
