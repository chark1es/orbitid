import { useState } from "react";
import { Page as PageLayout } from "../components/shared/page";
import type { InstanceSettings, SocialProviderConfig } from "@orbitid/shared";
import { Button, Input, Switch } from "@orbitid/ui";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { api, getApiUrl } from "../lib/api";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import {
  isCustomProviderKey,
  oauthCallbackUrl,
  providerInitial,
  providerLabel,
  secretIsConfigured,
  socialProviderConfig,
} from "./_config/settings";
import {
  ErrorAlert,
  LoadingPage,
  MetaChip,
  PageHeader,
  SaveBar,
  SettingsSection,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";
import { AddProviderSheet } from "./_settings-social/add-provider-sheet";
import { BUILT_IN_KEYS, customProviderErrors } from "./_settings-social/model";
import { ProviderSheet } from "./_settings-social/provider-sheet";

function ProviderLine({ label, initial }: { label: string; initial: string }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className="grid size-[22px] shrink-0 place-items-center bg-foreground font-data text-[11px] font-medium text-background" aria-hidden>
        {initial}
      </span>
      <span className="truncate text-sm font-medium">{label}</span>
    </span>
  );
}

function ProviderRow({
  view,
  callbackUrl,
  onToggle,
  onConfigure,
}: {
  view: {
    key: string;
    config: SocialProviderConfig;
    configured: boolean;
    label: string;
  };
  callbackUrl: string;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-border py-2 first:border-t-0">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <ProviderLine label={view.label} initial={providerInitial(view.key, view.config)} />
        {isCustomProviderKey(view.key) ? (
          <MetaChip>{view.config.protocol === "oauth2" ? "Custom OAuth 2.0" : "Custom OIDC"}</MetaChip>
        ) : null}
        {view.configured ? <MetaChip>Configured</MetaChip> : null}
      </div>
      <span className="hidden max-w-[32ch] truncate font-data text-xs text-muted-foreground 2xl:block" title={callbackUrl}>
        {callbackUrl}
      </span>
      <span className="w-7 text-right text-xs text-muted-foreground">{view.config.enabled ? "On" : "Off"}</span>
      <Switch
        checked={view.config.enabled}
        onCheckedChange={onToggle}
        aria-label={`Enable ${view.label}`}
      />
      <Button variant="outline" size="sm" onClick={onConfigure}>
        Configure
      </Button>
    </li>
  );
}

/** Validation shared with the server policy, plus the Apple .p8 triple that replaces a client secret. */
function providerErrors(key: string, config: SocialProviderConfig): string[] {
  const errors = customProviderErrors(key, config);
  if (!config.enabled || key !== "apple") return errors;
  const label = providerLabel(key, config);
  const usesAppleKey = Boolean(config.appleTeamId?.trim() || config.appleKeyId?.trim() || secretIsConfigured(config.applePrivateKey));
  if (usesAppleKey) {
    if (!config.appleTeamId?.trim()) errors.push(`${label}: team ID is required when the .p8 key is used.`);
    if (!config.appleKeyId?.trim()) errors.push(`${label}: key ID is required when the .p8 key is used.`);
    if (!secretIsConfigured(config.applePrivateKey)) errors.push(`${label}: paste the .p8 private key, or use a client secret instead.`);
  }
  return errors;
}

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [showMoreProviders, setShowMoreProviders] = useState(false);
  const apiUrl = getApiUrl();

  if (editor.isLoading) return <LoadingPage rows={3} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Social connections" description="OAuth providers and custom OpenID Connect or OAuth 2.0 connections." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const customKeys = Object.keys(settings.social).filter((key) => !BUILT_IN_KEYS.includes(key));
  const providers = [...BUILT_IN_KEYS, ...customKeys];
  const enabledCount = providers.filter((key) => settings.social[key]?.enabled).length;
  const socialErrors = providers.flatMap((key) => providerErrors(key, socialProviderConfig(settings, key)));

  const providerViews = providers.map((key, index) => {
    const config = socialProviderConfig(settings, key);
    const appleKey =
      key === "apple" &&
      Boolean(config.appleTeamId?.trim() || config.appleKeyId?.trim() || secretIsConfigured(config.applePrivateKey));
    const configured = Boolean(config.clientId && (config.clientSecret || appleKey || isCustomProviderKey(key)));
    return { key, index, config, appleKey, configured, label: providerLabel(key, config) };
  });
  const providerRank = (view: (typeof providerViews)[number]) =>
    view.config.enabled ? 0 : view.configured ? 1 : 2;
  const search = providerQuery.trim().toLowerCase();
  const matching = [...providerViews]
    .sort((a, b) => providerRank(a) - providerRank(b) || a.index - b.index)
    .filter((view) => !search || view.label.toLowerCase().includes(search) || view.key.toLowerCase().includes(search));
  // Enabled and configured providers stay on top. The untouched presets are one disclosure away, so
  // the page is a short list of what this instance actually uses instead of a wall of switches.
  const pinnedProviders = matching.filter((view) => providerRank(view) < 2);
  const presetProviders = matching.filter((view) => providerRank(view) === 2);
  const showPresets = search.length > 0 || showMoreProviders;

  const selectedConfig = selectedKey ? socialProviderConfig(settings, selectedKey) : null;

  const updateProvider = (key: string, patch: Partial<SocialProviderConfig>) => {
    editor.patch({ social: { [key]: { ...socialProviderConfig(settings, key), ...patch } } });
  };

  const addProvider = (key: string, config: SocialProviderConfig) => {
    editor.patch({ social: { [key]: config } });
    toast.success("Provider added. Save settings to turn it on.");
    setAddOpen(false);
    setSelectedKey(key);
  };

  const deleteProvider = async () => {
    if (!deletingKey) return;
    setDeletePending(true);
    try {
      const next = await api<InstanceSettings>("DELETE", `/instance/social/${deletingKey}`);
      toast.success("Provider deleted");
      if (selectedKey === deletingKey) setSelectedKey(null);
      setDeletingKey(null);
      editor.apply(next);
    } catch (error) {
      toast.error("Could not delete provider", { description: error instanceof Error ? error.message : "Try again." });
    } finally {
      setDeletePending(false);
    }
  };

  const callbackFor = (key: string) => oauthCallbackUrl(apiUrl, key);
  const deletingLabel = deletingKey ? providerLabel(deletingKey, socialProviderConfig(settings, deletingKey)) : "";

  return (
    <PageLayout>
      <PageHeader
        title="Social connections"
        description="Let users sign in with an external identity provider. Credentials stay on the server and secrets are write-only."
        badge={<MetaChip>{enabledCount} enabled</MetaChip>}
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden /> Add custom provider
          </Button>
        }
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection title="Providers" description="Turn a provider on, then add its client credentials. The callback URL must be registered with the provider.">
        <div className="flex flex-wrap items-center gap-2 pb-2">
          <Input
            value={providerQuery}
            onChange={(event) => setProviderQuery(event.target.value)}
            placeholder="Search providers"
            aria-label="Search providers"
            className="h-8 max-w-xs"
          />
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {search ? `${matching.length} matching` : `${pinnedProviders.length} enabled or configured`}
          </span>
        </div>
        <ul className="-mt-3 border-b border-border">
          {pinnedProviders.map((view) => (
            <ProviderRow
              key={view.key}
              view={view}
              callbackUrl={callbackFor(view.key)}
              onToggle={(enabled) => updateProvider(view.key, { enabled })}
              onConfigure={() => setSelectedKey(view.key)}
            />
          ))}
          {matching.length === 0 ? (
            <li className="border-t border-border py-3 text-sm text-muted-foreground first:border-t-0">
              No provider matches “{providerQuery.trim()}”.
            </li>
          ) : null}
        </ul>
        <ul id="social-preset-providers" className={showPresets && presetProviders.length > 0 ? "border-b border-border" : undefined}>
          {showPresets
            ? presetProviders.map((view) => (
                <ProviderRow
                  key={view.key}
                  view={view}
                  callbackUrl={callbackFor(view.key)}
                  onToggle={(enabled) => updateProvider(view.key, { enabled })}
                  onConfigure={() => setSelectedKey(view.key)}
                />
              ))
            : null}
        </ul>
        {presetProviders.length > 0 && !search ? (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-2">
            <p className="text-xs text-muted-foreground">
              {presetProviders.length} other providers are available, off until you configure them.
            </p>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showMoreProviders}
              aria-controls="social-preset-providers"
              onClick={() => setShowMoreProviders((open) => !open)}
            >
              {showMoreProviders ? "Fewer providers" : `More providers (${presetProviders.length})`}
            </Button>
          </div>
        ) : null}
      </SettingsSection>

      {selectedKey && selectedConfig ? (
        <ProviderSheet
          key={selectedKey}
          providerKey={selectedKey}
          config={selectedConfig}
          apiUrl={apiUrl}
          open
          onOpenChange={(open) => !open && setSelectedKey(null)}
          callbackUrl={callbackFor(selectedKey)}
          onChange={(patch) => updateProvider(selectedKey, patch)}
          onDelete={() => setDeletingKey(selectedKey)}
        />
      ) : null}

      <AddProviderSheet open={addOpen} onOpenChange={setAddOpen} apiUrl={apiUrl} existingKeys={providers} onAdd={addProvider} />

      <ConfirmDialog
        open={Boolean(deletingKey)}
        onOpenChange={(open) => !open && setDeletingKey(null)}
        title={`Delete ${deletingLabel || "provider"}?`}
        description="Users can no longer sign in with this provider. Linked accounts stay on their users, so existing users keep their details. This cannot be undone."
        confirmLabel="Delete provider"
        destructive
        pending={deletePending}
        onConfirm={() => void deleteProvider()}
      />

      <SaveBar
        dirty={editor.dirty}
        saving={editor.saving}
        disabled={socialErrors.length > 0}
        errors={socialErrors}
        error={editor.saveError}
        onSave={editor.save}
        onDiscard={editor.reset}
      />
    </PageLayout>
  );
}
