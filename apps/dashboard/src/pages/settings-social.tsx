import { useEffect, useState } from "react";
import { SOCIAL_PROVIDERS, type SocialProviderConfig } from "@orbitid/shared";
import { Button, Input, Switch, Textarea } from "@orbitid/ui";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { getApiUrl } from "../lib/api";
import {
  isCustomProviderKey,
  isHttpUrl,
  socialProviderConfig,
  listToText,
  oauthCallbackUrl,
  providerInitial,
  providerLabel,
  secretInputValue,
  secretIsConfigured,
  textToList,
} from "./_config/settings";
import {
  CheckboxRow,
  CopyButton,
  DetailSheet,
  ErrorAlert,
  Field,
  LoadingPage,
  MetaChip,
  PageHeader,
  SaveBar,
  SecretInput,
  SecretSetChip,
  SettingsSection,
  ValidationSummary,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

const BUILT_IN_KEYS: string[] = [...SOCIAL_PROVIDERS];

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

function ProviderLine({ label, initial }: { label: string; initial: string }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span
        className="grid size-[22px] shrink-0 place-items-center bg-foreground font-data text-[11px] font-medium text-background"
        aria-hidden
      >
        {initial}
      </span>
      <span className="truncate text-sm font-medium">{label}</span>
    </span>
  );
}

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customKey, setCustomKey] = useState("");
  const [customDiscovery, setCustomDiscovery] = useState("");
  const [customClientId, setCustomClientId] = useState("");
  const [customSecret, setCustomSecret] = useState("");
  const [customScopes, setCustomScopes] = useState("openid, email, profile");

  if (editor.isLoading) return <LoadingPage rows={3} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Social connections" description="OAuth providers and custom OpenID Connect connections." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const customKeys = Object.keys(settings.social).filter((key) => !BUILT_IN_KEYS.includes(key));
  const providers = [...BUILT_IN_KEYS, ...customKeys];
  const enabledCount = providers.filter((key) => settings.social[key]?.enabled).length;
  const socialErrors: string[] = [];
  for (const key of providers) {
    const config = socialProviderConfig(settings, key);
    if (!config.enabled) continue;
    const label = providerLabel(key, config);
    if (!config.clientId.trim()) socialErrors.push(`${label}: client ID is required.`);
    // Apple signs its own client secret from the .p8 key, so a stored client secret is optional there.
    const usesAppleKey = key === "apple" && (Boolean(config.appleTeamId?.trim()) || Boolean(config.appleKeyId?.trim()) || secretIsConfigured(config.applePrivateKey));
    if (!config.clientSecret && !usesAppleKey) socialErrors.push(`${label}: client secret is required.`);
    if (key === "apple" && usesAppleKey) {
      if (!config.appleTeamId?.trim()) socialErrors.push(`${label}: team ID is required when the .p8 key is used.`);
      if (!config.appleKeyId?.trim()) socialErrors.push(`${label}: key ID is required when the .p8 key is used.`);
      if (!secretIsConfigured(config.applePrivateKey)) socialErrors.push(`${label}: paste the .p8 private key, or use a client secret instead.`);
    }
    if (isCustomProviderKey(key) && !isHttpUrl(config.discoveryUrl ?? "")) socialErrors.push(`${label}: discovery URL must be an http(s) URL.`);
  }

  const selectedConfig = selectedKey ? socialProviderConfig(settings, selectedKey) : null;

  const resetDialog = () => {
    setCustomName("");
    setCustomKey("");
    setCustomDiscovery("");
    setCustomClientId("");
    setCustomSecret("");
    setCustomScopes("openid, email, profile");
  };

  const customKeyValue = customKey.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const customErrors: string[] = [];
  if (!customName.trim()) customErrors.push("Name is required.");
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(customKeyValue)) customErrors.push("Key must use lowercase letters, numbers, dashes or underscores.");
  if (providers.includes(`custom_${customKeyValue}`)) customErrors.push("That provider key already exists.");
  if (!isHttpUrl(customDiscovery)) customErrors.push("Discovery URL must be an http(s) URL.");
  if (!customClientId.trim()) customErrors.push("Client ID is required.");
  if (!customSecret.trim()) customErrors.push("Client secret is required.");

  const addCustomProvider = () => {
    if (customErrors.length > 0) return;
    editor.patch({
      social: {
        [`custom_${customKeyValue}`]: {
          enabled: true,
          name: customName.trim(),
          clientId: customClientId.trim(),
          clientSecret: customSecret,
          discoveryUrl: customDiscovery.trim(),
          scopes: textToList(customScopes),
          authenticatableAtSignIn: true,
        },
      },
    });
    toast.success("Custom provider added. Save settings to turn it on.");
    setAddOpen(false);
    resetDialog();
  };

  const updateProvider = (key: string, patch: Partial<SocialProviderConfig>) => {
    editor.patch({ social: { [key]: { ...socialProviderConfig(settings, key), ...patch } } });
  };

  const callbackFor = (key: string) => oauthCallbackUrl(getApiUrl(), key);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Social connections"
        description="Let users sign in with an external identity provider. Credentials stay on the server and secrets are write-only."
        badge={<MetaChip>{enabledCount} enabled</MetaChip>}
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden /> Add custom OIDC provider
          </Button>
        }
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection
        title="Providers"
        description="Turn a provider on, then add its client credentials. The callback URL must be registered with the provider."
      >
        <ul className="-mt-3 border-b border-border">
          {providers.map((key) => {
            const config = socialProviderConfig(settings, key);
            const appleKey = key === "apple" && Boolean(config.appleTeamId?.trim() || config.appleKeyId?.trim() || secretIsConfigured(config.applePrivateKey));
            const configured = Boolean(config.clientId && (config.clientSecret || appleKey));
            return (
              <li key={key} className="flex flex-wrap items-center gap-3 border-t border-border py-3 first:border-t-0">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <ProviderLine label={providerLabel(key, config)} initial={providerInitial(key, config)} />
                  {isCustomProviderKey(key) ? <MetaChip>Custom OIDC</MetaChip> : null}
                  {configured ? <MetaChip>Configured</MetaChip> : null}
                </div>
                <span className="hidden max-w-[42ch] truncate font-data text-xs text-muted-foreground xl:block">{callbackFor(key)}</span>
                <span className="text-xs text-muted-foreground">{config.enabled ? "On" : "Off"}</span>
                <Switch
                  checked={config.enabled}
                  onCheckedChange={(enabled) => updateProvider(key, { enabled })}
                  aria-label={`Enable ${providerLabel(key, config)}`}
                />
                <Button variant="outline" size="sm" onClick={() => setSelectedKey(key)}>
                  Configure
                </Button>
              </li>
            );
          })}
        </ul>
      </SettingsSection>

      <DetailSheet
        open={Boolean(selectedKey && selectedConfig)}
        onOpenChange={(open) => !open && setSelectedKey(null)}
        title={selectedKey && selectedConfig ? providerLabel(selectedKey, selectedConfig) : "Provider"}
        description={
          selectedKey && selectedConfig
            ? isCustomProviderKey(selectedKey)
              ? "Custom OpenID Connect provider."
              : "OAuth provider settings. Changes apply after you save the page."
            : undefined
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setSelectedKey(null)}>
              Close
            </Button>
            {selectedKey && selectedConfig && isCustomProviderKey(selectedKey) && selectedConfig.enabled ? (
              <Button
                variant="destructive"
                onClick={() => {
                  updateProvider(selectedKey, { enabled: false });
                  toast.success("Provider disabled. Save settings to apply it.");
                }}
              >
                Disable provider
              </Button>
            ) : null}
          </>
        }
      >
        {selectedKey && selectedConfig ? (
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4 border-b border-border pb-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Enabled</p>
                <p className="text-xs text-muted-foreground">Offer this provider on the sign-in and sign-up forms.</p>
              </div>
              <Switch
                checked={selectedConfig.enabled}
                onCheckedChange={(enabled) => updateProvider(selectedKey, { enabled })}
                aria-label={`Enable ${providerLabel(selectedKey, selectedConfig)}`}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Client ID" htmlFor={`${selectedKey}-client-id`} description={selectedKey === "apple" ? "The Apple Services ID." : undefined}>
                <Input
                  id={`${selectedKey}-client-id`}
                  value={selectedConfig.clientId}
                  disabled={!selectedConfig.enabled}
                  onChange={(event) => updateProvider(selectedKey, { clientId: event.target.value })}
                  className="font-data text-xs"
                />
              </Field>
              {selectedKey === "apple" ? (
                <Field label="Team ID" htmlFor="apple-team-id" description="From the Apple developer account.">
                  <Input
                    id="apple-team-id"
                    value={selectedConfig.appleTeamId ?? ""}
                    disabled={!selectedConfig.enabled}
                    onChange={(event) => updateProvider(selectedKey, { appleTeamId: event.target.value })}
                    placeholder="TEAM123456"
                    className="font-data text-xs"
                  />
                </Field>
              ) : (
                <SecretInput
                  id={`${selectedKey}-client-secret`}
                  label="Client secret"
                  configured={secretIsConfigured(selectedConfig.clientSecret)}
                  disabled={!selectedConfig.enabled}
                  value={secretInputValue(selectedConfig.clientSecret)}
                  onChange={(clientSecret) => updateProvider(selectedKey, { clientSecret })}
                  description={
                    secretIsConfigured(selectedConfig.clientSecret)
                      ? "A secret is stored. Leave blank to keep it."
                      : "Shown once by the provider when you create the app."
                  }
                />
              )}
            </div>
            {selectedKey === "apple" ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Key ID" htmlFor="apple-key-id" description="The 10-character identifier of the .p8 key.">
                    <Input
                      id="apple-key-id"
                      value={selectedConfig.appleKeyId ?? ""}
                      disabled={!selectedConfig.enabled}
                      onChange={(event) => updateProvider(selectedKey, { appleKeyId: event.target.value })}
                      placeholder="KEY7890123"
                      className="font-data text-xs"
                    />
                  </Field>
                </div>
                <Field
                  label={
                    <span className="flex flex-wrap items-center gap-2">
                      Private key (.p8)
                      <SecretSetChip configured={secretIsConfigured(selectedConfig.applePrivateKey)} />
                    </span>
                  }
                  htmlFor="apple-private-key"
                  description="Paste the whole file, including the BEGIN PRIVATE KEY and END PRIVATE KEY lines. The server uses it to sign the client secret for each token request."
                >
                  <Textarea
                    id="apple-private-key"
                    rows={6}
                    spellCheck={false}
                    autoComplete="off"
                    disabled={!selectedConfig.enabled}
                    value={secretInputValue(selectedConfig.applePrivateKey)}
                    onChange={(event) => updateProvider(selectedKey, { applePrivateKey: event.target.value })}
                    placeholder={secretIsConfigured(selectedConfig.applePrivateKey) ? "Stored key, leave blank to keep" : "-----BEGIN PRIVATE KEY-----"}
                    className="font-data text-xs"
                  />
                </Field>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Register <code className="font-data">{callbackFor(selectedKey)}</code> as the return URL in the Apple
                  developer console, and request the <code className="font-data">name</code> and{" "}
                  <code className="font-data">email</code> scopes. A client secret is optional: if one is stored it is used
                  verbatim instead of signing the .p8 key.
                </p>
                <SecretInput
                  id="apple-client-secret"
                  label="Client secret (optional)"
                  configured={secretIsConfigured(selectedConfig.clientSecret)}
                  disabled={!selectedConfig.enabled}
                  value={secretInputValue(selectedConfig.clientSecret)}
                  onChange={(clientSecret) => updateProvider(selectedKey, { clientSecret })}
                  description="Only when you generate the JWT elsewhere. Leave blank to sign it from the .p8 key."
                  placeholder={secretIsConfigured(selectedConfig.clientSecret) ? "Stored secret, leave blank to keep" : "Not used"}
                />
              </>
            ) : null}
            {isCustomProviderKey(selectedKey) ? (
              <Field label="Discovery URL" htmlFor={`${selectedKey}-discovery`} description="OpenID Connect discovery document.">
                <Input
                  id={`${selectedKey}-discovery`}
                  value={selectedConfig.discoveryUrl ?? ""}
                  disabled={!selectedConfig.enabled}
                  onChange={(event) => updateProvider(selectedKey, { discoveryUrl: event.target.value })}
                  placeholder="https://auth.example.com/.well-known/openid-configuration"
                  className="font-data text-xs"
                />
              </Field>
            ) : null}
            <Field label="Scopes" description="Comma-separated OAuth scopes requested from the provider.">
              <ScopesInput value={selectedConfig.scopes} onChange={(scopes) => updateProvider(selectedKey, { scopes })} />
            </Field>
            <div className="flex items-center justify-between gap-4 border-y border-border py-2">
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-medium">Callback URL</p>
                <code className="block truncate font-data text-xs text-muted-foreground">{callbackFor(selectedKey)}</code>
              </div>
              <CopyButton value={callbackFor(selectedKey)} size="sm" variant="outline" label="Copy" />
            </div>
            <CheckboxRow
              label="Authenticatable at sign-in"
              description="Show this provider on the sign-in form."
              checked={selectedConfig.authenticatableAtSignIn}
              disabled={!selectedConfig.enabled}
              onCheckedChange={(authenticatableAtSignIn) => updateProvider(selectedKey, { authenticatableAtSignIn })}
            />
          </div>
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetDialog();
        }}
        title="Add custom OIDC provider"
        description="Connect any OpenID Connect provider that publishes a discovery document."
        footer={
          <>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addCustomProvider} disabled={customErrors.length > 0}>
              Add provider
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Display name" htmlFor="custom-name" required>
            <Input id="custom-name" value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Acme SSO" />
          </Field>
          <Field
            label="Provider key"
            htmlFor="custom-key"
            required
            description="Stored as custom_<key>. It appears in strategies and in the callback URL."
          >
            <Input
              id="custom-key"
              value={customKey}
              onChange={(event) => setCustomKey(event.target.value)}
              placeholder="acme"
              className="font-data text-xs"
            />
          </Field>
          <Field label="Discovery URL" htmlFor="custom-discovery" required>
            <Input
              id="custom-discovery"
              value={customDiscovery}
              onChange={(event) => setCustomDiscovery(event.target.value)}
              placeholder="https://auth.acme.com/.well-known/openid-configuration"
              className="font-data text-xs"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Client ID" htmlFor="custom-client-id" required>
              <Input
                id="custom-client-id"
                value={customClientId}
                onChange={(event) => setCustomClientId(event.target.value)}
                className="font-data text-xs"
              />
            </Field>
            <Field label="Client secret" htmlFor="custom-client-secret" required>
              <Input
                id="custom-client-secret"
                type="password"
                autoComplete="new-password"
                value={customSecret}
                onChange={(event) => setCustomSecret(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Scopes" htmlFor="custom-scopes">
            <Input id="custom-scopes" value={customScopes} onChange={(event) => setCustomScopes(event.target.value)} className="font-data text-xs" />
          </Field>
          {customKeyValue ? (
            <div className="flex items-center justify-between gap-4 border-y border-border py-2">
              <div className="min-w-0">
                <p className="text-[0.8125rem] font-medium">Callback URL</p>
                <code className="block truncate font-data text-xs text-muted-foreground">
                  {oauthCallbackUrl(getApiUrl(), `custom_${customKeyValue}`)}
                </code>
              </div>
              <CopyButton value={oauthCallbackUrl(getApiUrl(), `custom_${customKeyValue}`)} size="sm" variant="outline" label="Copy" />
            </div>
          ) : null}
          <ValidationSummary errors={customErrors} title="Fill the required fields" />
        </div>
      </DetailSheet>

      <SaveBar
        dirty={editor.dirty}
        saving={editor.saving}
        disabled={socialErrors.length > 0}
        errors={socialErrors}
        error={editor.saveError}
        onSave={editor.save}
        onDiscard={editor.reset}
      />
    </div>
  );
}
