import { useEffect, useState } from "react";
import { SOCIAL_PROVIDERS, type SocialProviderConfig } from "@orbitid/shared";
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
  Switch,
} from "@orbitid/ui";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getApiUrl } from "../lib/api";
import {
  PROVIDER_ACCENTS,
  PROVIDER_LABELS,
  socialProviderConfig,
  isCustomProviderKey,
  isHttpUrl,
  listToText,
  oauthCallbackUrl,
  providerInitial,
  providerLabel,
  secretInputValue,
  secretIsConfigured,
  textToList,
} from "./_config/settings";
import {
  CopyButton,
  ErrorAlert,
  Field,
  LoadingPage,
  PageHeader,
  SaveBar,
  SectionCard,
  SwitchRow,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

const BUILT_IN_KEYS: string[] = [...SOCIAL_PROVIDERS];

function ScopesInput({ value, onChange }: { value: string[]; onChange: (scopes: string[]) => void }) {
  const [text, setText] = useState(() => listToText(value));
  useEffect(() => {
    if (textToList(text).join("\u0000") !== value.join("\u0000")) setText(listToText(value));
    // Only resync on external changes (save/discard); preserves in-progress typing.
  }, [value.join("\u0000")]);
  return (
    <Input
      value={text}
      onChange={(event) => {
        setText(event.target.value);
        onChange(textToList(event.target.value));
      }}
      placeholder="openid, email, profile"
    />
  );
}

function ProviderCard({
  providerKey,
  config,
  onChange,
}: {
  providerKey: string;
  config: SocialProviderConfig;
  onChange: (patch: Partial<SocialProviderConfig>) => void;
}) {
  const label = providerLabel(providerKey, config);
  const accent = PROVIDER_ACCENTS[providerKey] ?? "#6366f1";
  const callback = oauthCallbackUrl(getApiUrl(), providerKey);
  const secretConfigured = secretIsConfigured(config.clientSecret);
  const custom = isCustomProviderKey(providerKey);

  return (
    <SectionCard
      className="gap-3"
      title={
        <span className="flex items-center gap-2.5">
          <span
            className="grid size-8 shrink-0 place-items-center rounded-lg text-sm font-semibold text-white"
            style={{ backgroundColor: accent }}
            aria-hidden
          >
            {providerInitial(providerKey, config)}
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {label}
            {custom ? <Badge variant="outline">Custom OIDC</Badge> : null}
          </span>
        </span>
      }
      description={custom ? config.discoveryUrl || "Custom OpenID Connect provider" : `Callback: ${callback}`}
      actions={
        <div className="flex items-center gap-2">
          <Badge variant={config.enabled ? "default" : "secondary"}>{config.enabled ? "On" : "Off"}</Badge>
          <Switch checked={config.enabled} onCheckedChange={(enabled) => onChange({ enabled })} />
        </div>
      }
    >
      <div className={config.enabled ? "space-y-3" : "space-y-3 opacity-60"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Client ID" htmlFor={`${providerKey}-client-id`}>
            <Input
              id={`${providerKey}-client-id`}
              value={config.clientId}
              disabled={!config.enabled}
              onChange={(event) => onChange({ clientId: event.target.value })}
              placeholder="Client ID"
            />
          </Field>
          <Field
            label={
              <span className="flex items-center gap-2">
                Client secret
                {secretConfigured ? <Badge variant="outline">Configured</Badge> : null}
              </span>
            }
            htmlFor={`${providerKey}-client-secret`}
            description="Leave blank to keep the stored secret."
          >
            <Input
              id={`${providerKey}-client-secret`}
              type="password"
              autoComplete="new-password"
              disabled={!config.enabled}
              value={secretInputValue(config.clientSecret)}
              onChange={(event) => onChange({ clientSecret: event.target.value })}
              placeholder={secretConfigured ? "Stored secret — leave blank to keep" : "Client secret"}
            />
          </Field>
        </div>
        {custom ? (
          <Field label="Discovery URL" htmlFor={`${providerKey}-discovery`} description="OpenID Connect discovery document.">
            <Input
              id={`${providerKey}-discovery`}
              value={config.discoveryUrl ?? ""}
              disabled={!config.enabled}
              onChange={(event) => onChange({ discoveryUrl: event.target.value })}
              placeholder="https://auth.example.com/.well-known/openid-configuration"
            />
          </Field>
        ) : null}
        <Field label="Scopes" htmlFor={`${providerKey}-scopes`} description="Comma-separated OAuth scopes requested from the provider.">
          <ScopesInput value={config.scopes} onChange={(scopes) => onChange({ scopes })} />
        </Field>
        <div className="flex flex-col gap-2 rounded-lg border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-medium">Redirect / callback URL</p>
            <code className="block truncate text-xs text-muted-foreground">{callback}</code>
          </div>
          <CopyButton value={callback} size="sm" variant="outline" label="Copy" />
        </div>
        <SwitchRow
          label="Authenticatable at sign-in"
          description="Offer this provider on the sign-in and sign-up forms."
          checked={config.authenticatableAtSignIn}
          disabled={!config.enabled}
          onCheckedChange={(authenticatableAtSignIn) => onChange({ authenticatableAtSignIn })}
        />
      </div>
    </SectionCard>
  );
}

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [dialogOpen, setDialogOpen] = useState(false);
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
        <PageHeader title="Social connections" description="Configure OAuth providers and custom OIDC connections." />
        <ErrorAlert error={editor.error ?? "Could not load instance settings."} onRetry={editor.refetch} />
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
    if (!config.clientSecret) socialErrors.push(`${label}: client secret is required.`);
    if (isCustomProviderKey(key) && !isHttpUrl(config.discoveryUrl ?? "")) socialErrors.push(`${label}: discovery URL must be an http(s) URL.`);
  }

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
  if (BUILT_IN_KEYS.includes(`custom_${customKeyValue}`)) customErrors.push("That provider already exists.");
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
    toast.success("Custom provider added — save to enable it.");
    setDialogOpen(false);
    resetDialog();
  };

  const updateProvider = (key: string, patch: Partial<SocialProviderConfig>) => {
    const config = socialProviderConfig(settings, key);
    editor.patch({ social: { [key]: { ...config, ...patch } } });
  };

  const disableProvider = (key: string) => updateProvider(key, { enabled: false });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Social connections"
        description="Let users sign in with an external identity provider. Credentials are stored server-side; secrets are write-only."
        badge={<Badge variant="outline">{enabledCount} enabled</Badge>}
        actions={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="size-4" /> Add custom OIDC provider
          </Button>
        }
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <div className="grid gap-4 xl:grid-cols-2">
        {providers.map((key) => {
          const config = socialProviderConfig(settings, key);
          return (
            <div key={key} className="space-y-2">
              <ProviderCard providerKey={key} config={config} onChange={(patch) => updateProvider(key, patch)} />
              {isCustomProviderKey(key) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  onClick={() => disableProvider(key)}
                >
                  <Trash2 className="size-4" /> Disable custom provider
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetDialog();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add custom OIDC provider</DialogTitle>
            <DialogDescription>Connect any OpenID Connect provider that publishes a discovery document.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Display name" htmlFor="custom-name" required>
              <Input id="custom-name" value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Acme SSO" />
            </Field>
            <Field label="Provider key" htmlFor="custom-key" required description="Used as `custom_<key>` in strategies and callback URLs.">
              <Input
                id="custom-key"
                value={customKey}
                onChange={(event) => setCustomKey(event.target.value)}
                placeholder="acme"
              />
            </Field>
            <Field label="Discovery URL" htmlFor="custom-discovery" required>
              <Input
                id="custom-discovery"
                value={customDiscovery}
                onChange={(event) => setCustomDiscovery(event.target.value)}
                placeholder="https://auth.acme.com/.well-known/openid-configuration"
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Client ID" htmlFor="custom-client-id" required>
                <Input id="custom-client-id" value={customClientId} onChange={(event) => setCustomClientId(event.target.value)} />
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
              <Input id="custom-scopes" value={customScopes} onChange={(event) => setCustomScopes(event.target.value)} />
            </Field>
            {customKeyValue ? (
              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                <span className="text-muted-foreground">Callback URL: </span>
                <code className="break-all">{oauthCallbackUrl(getApiUrl(), `custom_${customKeyValue}`)}</code>
              </div>
            ) : null}
            {customErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {customErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addCustomProvider} disabled={customErrors.length > 0}>
              Add provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {socialErrors.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Fix the following before saving</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {socialErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <SaveBar dirty={editor.dirty} saving={editor.saving} disabled={socialErrors.length > 0} onSave={editor.save} onDiscard={editor.reset} />
    </div>
  );
}
