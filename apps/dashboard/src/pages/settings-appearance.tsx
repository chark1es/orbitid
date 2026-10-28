import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { isHttpOrigin, isHttpUrl } from "./_config/settings";
import {
  ErrorAlert,
  Field,
  LoadingPage,
  MetaChip,
  PageHeader,
  SaveBar,
  SettingsSection,
  StringListEditor,
  SwitchRow,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;

  if (editor.isLoading) return <LoadingPage rows={4} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Appearance" description="Branding, allowed origins, and development behavior." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const app = settings.application;
  const branding = settings.branding;
  const errors: string[] = [];
  if (!COLOR_PATTERN.test(branding.primaryColor)) errors.push("Primary color must be a hex color such as #2b2522.");
  if (!isHttpUrl(app.homeUrl)) errors.push("Home URL must be an http(s) URL.");
  if (app.allowedOrigins.some((origin) => !isHttpOrigin(origin))) errors.push("Every allowed origin must be an http(s) origin without a path.");
  if (app.allowedRedirectOrigins.some((origin) => !isHttpOrigin(origin))) errors.push("Every redirect origin must be an http(s) origin without a path.");

  const previewColor = COLOR_PATTERN.test(branding.primaryColor) ? branding.primaryColor : "#2b2522";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appearance"
        description="Brand the hosted sign-in experience and choose which origins may call the Frontend API."
        badge={<MetaChip>Instance settings</MetaChip>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection title="Branding" description="Applied to the prebuilt sign-in, sign-up, and profile components.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Primary color"
            htmlFor="primary-color"
            error={COLOR_PATTERN.test(branding.primaryColor) ? null : "Enter a hex color, for example #2b2522."}
          >
            <div className="flex items-center gap-2">
              <input
                id="primary-color-swatch"
                type="color"
                aria-label="Primary color picker"
                value={previewColor}
                onChange={(event) => editor.patch({ branding: { primaryColor: event.target.value } })}
                className="h-[34px] w-12 cursor-pointer border border-input bg-transparent p-1"
              />
              <Input
                id="primary-color"
                value={branding.primaryColor}
                onChange={(event) => editor.patch({ branding: { primaryColor: event.target.value } })}
                placeholder="#2b2522"
                className="font-data text-xs"
              />
            </div>
          </Field>
          <Field label="Theme" htmlFor="branding-theme" description="Default theme for hosted components. Visitors can override it.">
            <Select value={branding.theme} onValueChange={(theme) => editor.patch({ branding: { theme } })}>
              <SelectTrigger id="branding-theme" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <SwitchRow
          label="Show Powered by OrbitID"
          description="Display attribution beneath hosted forms."
          checked={branding.showPoweredBy}
          onCheckedChange={(showPoweredBy) => editor.patch({ branding: { showPoweredBy } })}
        />
        <div className="space-y-2 border-t border-border pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">Preview</p>
            <p className="text-xs text-muted-foreground">Current draft, before saving</p>
          </div>
          <div className="border border-border bg-muted/30 p-6">
            <div className="mx-auto w-full max-w-sm border border-border bg-card px-6 py-7">
              <div className="space-y-1 text-center">
                <div
                  className="mx-auto grid size-9 place-items-center text-sm font-semibold text-white"
                  style={{ backgroundColor: previewColor }}
                  aria-hidden
                >
                  {(app.name || "O").trim().charAt(0).toUpperCase()}
                </div>
                <p className="pt-2 text-[0.9375rem] font-semibold">{app.name || "Your application"}</p>
                <p className="text-xs text-muted-foreground">Sign in to continue</p>
              </div>
              <div className="mt-5 space-y-3">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Email address</p>
                  <div className="h-[34px] border border-input bg-background px-3 py-2 text-xs text-muted-foreground">you@example.com</div>
                </div>
                <div
                  className="grid h-[34px] place-items-center text-xs font-medium text-white"
                  style={{ backgroundColor: previewColor }}
                >
                  Continue
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-[11px] uppercase tracking-[0.04em] text-muted-foreground">or</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="grid h-[34px] place-items-center border border-border text-xs font-medium">Continue with Google</div>
                {branding.showPoweredBy ? (
                  <p className="pt-1 text-center text-[11px] text-muted-foreground">Powered by OrbitID</p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Origins and redirects" description="Only allowed origins get CORS access. Redirect origins limit where sign-in can send a user.">
        <Field label="Home URL" htmlFor="appearance-home" error={app.homeUrl && !isHttpUrl(app.homeUrl) ? "Enter an http(s) URL." : null}>
          <Input
            id="appearance-home"
            value={app.homeUrl}
            onChange={(event) => editor.patch({ application: { homeUrl: event.target.value } })}
            placeholder="https://example.com"
            className="font-data text-xs"
          />
        </Field>
        <Field label="Allowed origins" description="Origins allowed to call /v1/client/* with credentials.">
          <StringListEditor
            values={app.allowedOrigins}
            onChange={(allowedOrigins) => editor.patch({ application: { allowedOrigins } })}
            placeholder="https://example.com"
            addLabel="Add origin"
            emptyLabel="No origins configured. Browser clients cannot call the API until you add one."
          />
        </Field>
        <Field label="Allowed redirect origins" description="Origins permitted in redirect_url values after sign-in.">
          <StringListEditor
            values={app.allowedRedirectOrigins}
            onChange={(allowedRedirectOrigins) => editor.patch({ application: { allowedRedirectOrigins } })}
            placeholder="https://app.example.com"
            addLabel="Add redirect origin"
            emptyLabel="No additional redirect origins."
          />
        </Field>
      </SettingsSection>

      <SettingsSection title="Environment" description="Development conveniences. Turn them off before production.">
        <SwitchRow
          label="Development mode"
          description="Allows localhost origins automatically and logs additional diagnostics."
          checked={app.developmentMode}
          onCheckedChange={(developmentMode) => editor.patch({ application: { developmentMode } })}
        />
      </SettingsSection>

      <SaveBar
        dirty={editor.dirty}
        saving={editor.saving}
        disabled={errors.length > 0}
        errors={errors}
        error={editor.saveError}
        onSave={editor.save}
        onDiscard={editor.reset}
      />
    </div>
  );
}
