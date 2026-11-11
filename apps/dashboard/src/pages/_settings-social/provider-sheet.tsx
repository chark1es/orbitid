import { useEffect, useState } from "react";
import type { SocialProviderConfig } from "@orbitid/shared";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea } from "@orbitid/ui";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { errorMessage, listToText, providerLabel, secretInputValue, secretIsConfigured, textToList } from "../_config/settings";
import {
  CheckboxRow,
  CopyButton,
  DetailSheet,
  ErrorAlert,
  Field,
  SecretInput,
  SecretSetChip,
  ValidationSummary,
} from "../_config/ui";
import { CLAIM_FIELDS, customProviderErrors, previewBody, protocolOf } from "./model";

interface PreviewResult {
  ok: boolean;
  issuer?: string;
  endpoints: { authorization: string; token: string; userinfo?: string; jwks?: string };
  scopes_supported?: string[];
  pkce_supported?: boolean;
  client_auth_methods?: string[];
  checks: { name: string; url: string; reachable: boolean; status?: number; error?: string }[];
  warnings: string[];
  errors: string[];
}

function ScopesInput({ value, onChange }: { value: string[]; onChange: (scopes: string[]) => void }) {
  const [text, setText] = useState(() => listToText(value));
  useEffect(() => {
    if (textToList(text).join("\u0000") !== value.join("\u0000")) setText(listToText(value));
    // Resync only on external changes (save or discard) so typing is preserved.
  }, [value.join("\u0000")]);
  return (
    <Input
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(textToList(event.target.value));
      }}
      placeholder="openid, email, profile"
      className="font-data text-xs"
    />
  );
}

function TestPanel({ config }: { config: SocialProviderConfig }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api<PreviewResult>("POST", "/instance/social/test", previewBody(config)));
    } catch (caught) {
      setResult(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3 border-y border-border py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Test connection</p>
          <p className="text-xs text-muted-foreground">Checks the discovery document or the endpoints you entered. Nothing is saved.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void run()} disabled={busy}>
          {busy ? "Checking…" : "Test connection"}
        </Button>
      </div>
      {error ? <ErrorAlert error={error} /> : null}
      {result ? (
        <div className="space-y-2 text-xs" data-testid="social-test-result">
          <p className={result.ok ? "font-medium text-foreground" : "font-medium text-destructive"}>
            {result.ok ? "All checked endpoints answered." : "Some settings need attention."}
          </p>
          {result.issuer ? <p className="text-muted-foreground">Issuer: <code className="font-data">{result.issuer}</code></p> : null}
          <ul className="space-y-1">
            {result.checks.map((check) => (
              <li key={check.name} className="flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium">{check.name}</span>
                  <code className="ml-2 break-all font-data text-muted-foreground">{check.url}</code>
                </span>
                <span className={check.reachable ? "text-muted-foreground" : "text-destructive"}>
                  {check.reachable ? `Reachable${check.status ? ` (HTTP ${check.status})` : ""}` : check.error}
                </span>
              </li>
            ))}
          </ul>
          {result.pkce_supported !== undefined ? (
            <p className="text-muted-foreground">PKCE S256: {result.pkce_supported ? "advertised" : "not advertised"}</p>
          ) : null}
          {result.errors.map((message) => (
            <p key={message} className="text-destructive">{message}</p>
          ))}
          {result.warnings.map((message) => (
            <p key={message} className="text-muted-foreground">{message}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderSheet({
  providerKey,
  config,
  apiUrl,
  open,
  onOpenChange,
  callbackUrl,
  onChange,
  onDelete,
}: {
  providerKey: string;
  config: SocialProviderConfig;
  apiUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  callbackUrl: string;
  onChange: (patch: Partial<SocialProviderConfig>) => void;
  onDelete: () => void;
}) {
  const custom = providerKey.startsWith("custom_");
  const protocol = protocolOf(config);
  const usesManual = Boolean(config.authorizationUrl?.trim() || config.tokenUrl?.trim()) && !config.discoveryUrl?.trim();
  const [source, setSource] = useState<"discovery" | "manual">(usesManual ? "manual" : "discovery");
  const [draftKey, setDraftKey] = useState(providerKey);

  useEffect(() => setDraftKey(providerKey), [providerKey]);
  useEffect(() => setSource(usesManual ? "manual" : "discovery"), [usesManual, providerKey]);

  const apple = providerKey === "apple";
  const appleKey = apple && Boolean(config.appleTeamId?.trim() || config.appleKeyId?.trim() || secretIsConfigured(config.applePrivateKey));
  const errors = customProviderErrors(providerKey, { ...config, enabled: true });

  const switchSource = (next: "discovery" | "manual") => {
    setSource(next);
    if (next === "discovery") onChange({ authorizationUrl: "", tokenUrl: "", userinfoUrl: "", jwksUrl: "" });
    else onChange({ discoveryUrl: "" });
  };

  const mapping = {
    sub: "", email: "", emailVerified: "", name: "", firstName: "", lastName: "", username: "", picture: "",
    ...(config.claimMapping ?? {}),
  };
  const setMapping = (field: (typeof CLAIM_FIELDS)[number]["key"], value: string) =>
    onChange({ claimMapping: { ...mapping, [field]: value } });

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      title={providerLabel(providerKey, config)}
      description={custom ? (protocol === "oauth2" ? "Custom OAuth 2.0 provider." : "Custom OpenID Connect provider.") : "OAuth provider settings. Changes apply after you save the page."}
      footer={
        <>
          {custom ? (
            <Button variant="destructive" onClick={onDelete}>
              Delete provider
            </Button>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex items-center justify-between gap-4 border-b border-border pb-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Enabled</p>
            <p className="text-xs text-muted-foreground">Offer this provider on the sign-in and sign-up forms.</p>
          </div>
          <Switch checked={config.enabled} onCheckedChange={(enabled) => onChange({ enabled })} aria-label={`Enable ${config.name || providerKey}`} />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Display name" htmlFor={`${providerKey}-name`} description={custom ? "Shown on the sign-in button." : undefined}>
            <Input
              id={`${providerKey}-name`}
              value={config.name ?? ""}
              disabled={!config.enabled && !custom}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder={custom ? "Acme ID" : "Sign-in button label"}
            />
          </Field>
          <Field label="Provider key" htmlFor={`${providerKey}-key`} description={custom ? "Fixed once created: it is part of the strategy and callback URL." : undefined}>
            <Input id={`${providerKey}-key`} value={draftKey} disabled className="font-data text-xs" onChange={(event) => setDraftKey(event.target.value)} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Client ID" htmlFor={`${providerKey}-client-id`} description={apple ? "The Apple Services ID." : undefined}>
            <Input
              id={`${providerKey}-client-id`}
              value={config.clientId}
              disabled={!config.enabled}
              onChange={(event) => onChange({ clientId: event.target.value })}
              className="font-data text-xs"
            />
          </Field>
          {apple ? (
            <Field label="Team ID" htmlFor="apple-team-id" description="From the Apple developer account.">
              <Input
                id="apple-team-id"
                value={config.appleTeamId ?? ""}
                disabled={!config.enabled}
                onChange={(event) => onChange({ appleTeamId: event.target.value })}
                placeholder="TEAM123456"
                className="font-data text-xs"
              />
            </Field>
          ) : (
            <SecretInput
              id={`${providerKey}-client-secret`}
              label={custom && config.pkce !== false ? "Client secret (optional with PKCE)" : "Client secret"}
              configured={secretIsConfigured(config.clientSecret)}
              disabled={!config.enabled}
              value={secretInputValue(config.clientSecret)}
              onChange={(clientSecret) => onChange({ clientSecret })}
              description={secretIsConfigured(config.clientSecret) ? "A secret is stored. Leave blank to keep it." : "Shown once by the provider when you create the app."}
            />
          )}
        </div>

        {apple ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Key ID" htmlFor="apple-key-id" description="The 10-character identifier of the .p8 key.">
                <Input id="apple-key-id" value={config.appleKeyId ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ appleKeyId: event.target.value })} placeholder="KEY7890123" className="font-data text-xs" />
              </Field>
            </div>
            <Field
              label={<span className="flex flex-wrap items-center gap-2">Private key (.p8) <SecretSetChip configured={secretIsConfigured(config.applePrivateKey)} /></span>}
              htmlFor="apple-private-key"
              description="Paste the whole file, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines. The server uses it to sign the client secret for each token request."
            >
              <Textarea
                id="apple-private-key"
                rows={6}
                spellCheck={false}
                autoComplete="off"
                disabled={!config.enabled}
                value={secretInputValue(config.applePrivateKey)}
                onChange={(event) => onChange({ applePrivateKey: event.target.value })}
                placeholder={secretIsConfigured(config.applePrivateKey) ? "Stored key, leave blank to keep" : "-----BEGIN PRIVATE KEY-----"}
                className="font-data text-xs"
              />
            </Field>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Register <code className="font-data">{callbackUrl}</code> as the return URL in the Apple developer console, and request the{" "}
              <code className="font-data">name</code> and <code className="font-data">email</code> scopes. A client secret is optional: if one is stored it is used verbatim instead of signing the .p8 key.
            </p>
            <SecretInput
              id="apple-client-secret"
              label="Client secret (optional)"
              configured={secretIsConfigured(config.clientSecret)}
              disabled={!config.enabled}
              value={secretInputValue(config.clientSecret)}
              onChange={(clientSecret) => onChange({ clientSecret })}
              description="Only when you generate the JWT elsewhere. Leave blank to sign it from the .p8 key."
              placeholder={secretIsConfigured(config.clientSecret) ? "Stored secret; leave blank" : "Not used"}
            />
          </>
        ) : null}

        {custom ? (
          <>
            <Field label="Protocol" htmlFor={`${providerKey}-protocol`} description="OpenID Connect verifies an ID token; OAuth 2.0 reads the profile from userinfo.">
              <Select value={protocol} onValueChange={(value) => onChange({ protocol: value as "oidc" | "oauth2" })}>
                <SelectTrigger id={`${providerKey}-protocol`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OpenID Connect</SelectItem>
                  <SelectItem value="oauth2">OAuth 2.0</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Endpoint source" htmlFor={`${providerKey}-source`} description="Discovery is best: it validates the issuer and finds every endpoint.">
              <Select value={source} onValueChange={(value) => switchSource(value as "discovery" | "manual")}>
                <SelectTrigger id={`${providerKey}-source`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="discovery">Discovery document</SelectItem>
                  <SelectItem value="manual">Manual endpoints</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {source === "discovery" ? (
              <Field label="Discovery URL" htmlFor={`${providerKey}-discovery`} description="OpenID Connect discovery document.">
                <Input
                  id={`${providerKey}-discovery`}
                  value={config.discoveryUrl ?? ""}
                  disabled={!config.enabled}
                  onChange={(event) => onChange({ discoveryUrl: event.target.value })}
                  placeholder="https://auth.example.com/.well-known/openid-configuration"
                  className="font-data text-xs"
                />
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Authorization URL" htmlFor={`${providerKey}-auth-url`} required>
                  <Input id={`${providerKey}-auth-url`} value={config.authorizationUrl ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ authorizationUrl: event.target.value })} placeholder="https://provider.example/oauth/authorize" className="font-data text-xs" />
                </Field>
                <Field label="Token URL" htmlFor={`${providerKey}-token-url`} required>
                  <Input id={`${providerKey}-token-url`} value={config.tokenUrl ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ tokenUrl: event.target.value })} placeholder="https://provider.example/oauth/token" className="font-data text-xs" />
                </Field>
                <Field label="Userinfo URL" htmlFor={`${providerKey}-userinfo-url`} description="JSON profile endpoint.">
                  <Input id={`${providerKey}-userinfo-url`} value={config.userinfoUrl ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ userinfoUrl: event.target.value })} placeholder="https://provider.example/oauth/userinfo" className="font-data text-xs" />
                </Field>
                <Field label="JWKS URL" htmlFor={`${providerKey}-jwks-url`} description="Only when the provider returns a signed ID token.">
                  <Input id={`${providerKey}-jwks-url`} value={config.jwksUrl ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ jwksUrl: event.target.value })} placeholder="https://provider.example/.well-known/jwks.json" className="font-data text-xs" />
                </Field>
                <Field label="Issuer" htmlFor={`${providerKey}-issuer`} description="Expected `iss` claim; needed to verify an ID token.">
                  <Input id={`${providerKey}-issuer`} value={config.issuer ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ issuer: event.target.value })} placeholder="https://provider.example" className="font-data text-xs" />
                </Field>
              </div>
            )}
            <Field label="Logo URL" htmlFor={`${providerKey}-logo`} description="Optional image for the sign-in button.">
              <Input id={`${providerKey}-logo`} value={config.logoUrl ?? ""} disabled={!config.enabled} onChange={(event) => onChange({ logoUrl: event.target.value })} placeholder="https://cdn.example.com/acme.svg" className="font-data text-xs" />
            </Field>
            <Field label="Token endpoint authentication" htmlFor={`${providerKey}-auth-method`}>
              <Select value={config.clientAuthMethod ?? "client_secret_basic"} onValueChange={(value) => onChange({ clientAuthMethod: value as SocialProviderConfig["clientAuthMethod"] })}>
                <SelectTrigger id={`${providerKey}-auth-method`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="client_secret_basic">HTTP Basic (client_secret_basic)</SelectItem>
                  <SelectItem value="client_secret_post">Form body (client_secret_post)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <CheckboxRow label="Use PKCE (S256)" description="Recommended. Leave on for public clients with no secret." checked={config.pkce !== false} disabled={!config.enabled} onCheckedChange={(pkce) => onChange({ pkce })} />
              <CheckboxRow label="Trust email as verified" description="Only when the provider checks addresses but sends no email_verified claim." checked={config.trustEmailVerified ?? false} disabled={!config.enabled} onCheckedChange={(trustEmailVerified) => onChange({ trustEmailVerified })} />
            </div>
            <div className="space-y-3 border-t border-border pt-3">
              <div>
                <p className="text-sm font-medium">Claim mapping</p>
                <p className="text-xs text-muted-foreground">Dotted JSON path for each field; blank uses the provider's standard claim. Nested paths work, for example <code className="font-data">data.profile.id</code>.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {CLAIM_FIELDS.map((field) => (
                  <Field key={field.key} label={field.label} htmlFor={`${providerKey}-claim-${field.key}`}>
                    <Input
                      id={`${providerKey}-claim-${field.key}`}
                      value={config.claimMapping?.[field.key] ?? ""}
                      disabled={!config.enabled}
                      onChange={(event) => setMapping(field.key, event.target.value)}
                      placeholder={field.placeholder}
                      className="font-data text-xs"
                    />
                  </Field>
                ))}
              </div>
            </div>
          </>
        ) : null}

        <Field label="Scopes" description="Comma-separated OAuth scopes requested from the provider.">
          <ScopesInput value={config.scopes} onChange={(scopes) => onChange({ scopes })} />
        </Field>

        <div className="flex items-center justify-between gap-4 border-y border-border py-2">
          <div className="min-w-0">
            <p className="text-[0.8125rem] font-medium">Callback URL</p>
            <code className="block truncate font-data text-xs text-muted-foreground">{callbackUrl}</code>
          </div>
          <CopyButton value={callbackUrl} size="sm" variant="outline" label="Copy" />
        </div>

        {custom ? <TestPanel config={config} /> : null}

        <CheckboxRow
          label="Authenticatable at sign-in"
          description="Show this provider on the sign-in form."
          checked={config.authenticatableAtSignIn}
          disabled={!config.enabled}
          onCheckedChange={(authenticatableAtSignIn) => onChange({ authenticatableAtSignIn })}
        />

        {custom ? <ValidationSummary errors={errors} title="Fix these before saving" /> : null}
      </div>
    </DetailSheet>
  );
}
