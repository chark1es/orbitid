import { Alert, AlertDescription, AlertTitle, Badge, Card, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { Palette, ShieldCheck } from "lucide-react";
import { isHttpOrigin, isHttpUrl } from "./_config/settings";
import {
  ErrorAlert,
  Field,
  LoadingPage,
  PageHeader,
  SaveBar,
  SectionCard,
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
        <ErrorAlert error={editor.error ?? "Could not load instance settings."} onRetry={editor.refetch} />
      </div>
    );
  }

  const app = settings.application;
  const branding = settings.branding;
  const errors: string[] = [];
  if (!COLOR_PATTERN.test(branding.primaryColor)) errors.push("Primary color must be a hex color such as #6366f1.");
  if (!isHttpUrl(app.homeUrl)) errors.push("Home URL must be an http(s) URL.");
  if (app.allowedOrigins.some((origin) => !isHttpOrigin(origin))) errors.push("Every allowed origin must be an http(s) origin without a path.");
  if (app.allowedRedirectOrigins.some((origin) => !isHttpOrigin(origin))) errors.push("Every redirect origin must be an http(s) origin without a path.");

  const previewColor = COLOR_PATTERN.test(branding.primaryColor) ? branding.primaryColor : "#6366f1";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Appearance"
        description="Brand the hosted sign-in experience and control which origins may call the Frontend API."
        badge={<Badge variant="outline">Instance settings</Badge>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <SectionCard
            title={
              <span className="flex items-center gap-2">
                <Palette className="size-4" /> Branding
              </span>
            }
            description="Applied to `<SignIn/>`, `<SignUp/>`, and other prebuilt components."
          >
            <Field label="Primary color" htmlFor="primary-color" error={COLOR_PATTERN.test(branding.primaryColor) ? null : "Enter a hex color."}>
              <div className="flex items-center gap-2">
                <input
                  id="primary-color-swatch"
                  type="color"
                  aria-label="Primary color picker"
                  value={previewColor}
                  onChange={(event) => editor.patch({ branding: { primaryColor: event.target.value } })}
                  className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1"
                />
                <Input
                  id="primary-color"
                  value={branding.primaryColor}
                  onChange={(event) => editor.patch({ branding: { primaryColor: event.target.value } })}
                  placeholder="#6366f1"
                  className="font-mono"
                />
              </div>
            </Field>
            <Field label="Theme" htmlFor="branding-theme" description="Default theme for hosted components; users can override in their browser.">
              <Select value={branding.theme} onValueChange={(theme) => editor.patch({ branding: { theme } })}>
                <SelectTrigger id="branding-theme" className="w-full sm:max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <SwitchRow
              label="Show “Powered by OrbitID”"
              description="Display attribution beneath hosted forms."
              checked={branding.showPoweredBy}
              onCheckedChange={(showPoweredBy) => editor.patch({ branding: { showPoweredBy } })}
            />
          </SectionCard>

          <SectionCard
            title={
              <span className="flex items-center gap-2">
                <ShieldCheck className="size-4" /> Origins & redirects
              </span>
            }
            description="Only allowed origins receive CORS access. Redirect origins constrain post-auth destinations."
          >
            <Field label="Home URL" htmlFor="appearance-home" error={app.homeUrl && !isHttpUrl(app.homeUrl) ? "Enter an http(s) URL." : null}>
              <Input
                id="appearance-home"
                value={app.homeUrl}
                onChange={(event) => editor.patch({ application: { homeUrl: event.target.value } })}
                placeholder="https://example.com"
              />
            </Field>
            <Field label="Allowed origins" description="Origins allowed to call `/v1/client/*` with credentials.">
              <StringListEditor
                values={app.allowedOrigins}
                onChange={(allowedOrigins) => editor.patch({ application: { allowedOrigins } })}
                placeholder="https://example.com"
                addLabel="Add origin"
                emptyLabel="No origins configured."
              />
            </Field>
            <Field label="Allowed redirect origins" description="Origins permitted in `redirect_url` values after sign-in.">
              <StringListEditor
                values={app.allowedRedirectOrigins}
                onChange={(allowedRedirectOrigins) => editor.patch({ application: { allowedRedirectOrigins } })}
                placeholder="https://app.example.com"
                addLabel="Add redirect origin"
                emptyLabel="No additional redirect origins."
              />
            </Field>
          </SectionCard>

          <SectionCard title="Environment" description="Development conveniences. Disable before going to production.">
            <SwitchRow
              label="Development mode"
              description="Allows localhost origins automatically and logs additional diagnostics."
              checked={app.developmentMode}
              onCheckedChange={(developmentMode) => editor.patch({ application: { developmentMode } })}
            />
          </SectionCard>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Live preview</h2>
            <Badge variant="outline">{branding.theme}</Badge>
          </div>
          <div className="rounded-xl border bg-muted/40 p-4">
            <Card className="mx-auto w-full max-w-sm gap-4 px-5 py-6 shadow-md">
              <div className="space-y-1 text-center">
                <div
                  className="mx-auto grid size-10 place-items-center rounded-xl text-sm font-bold text-white"
                  style={{ backgroundColor: previewColor }}
                  aria-hidden
                >
                  {(app.name || "O").trim().charAt(0).toUpperCase()}
                </div>
                <p className="pt-1 text-base font-semibold">{app.name || "Your application"}</p>
                <p className="text-xs text-muted-foreground">Sign in to continue</p>
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Email address</p>
                  <div className="h-9 rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground">you@example.com</div>
                </div>
                <div
                  className="grid h-9 place-items-center rounded-md text-xs font-medium text-white"
                  style={{ backgroundColor: previewColor }}
                >
                  Continue
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-px flex-1 bg-border" />
                  <span className="text-[10px] uppercase text-muted-foreground">or</span>
                  <span className="h-px flex-1 bg-border" />
                </div>
                <div className="grid h-9 place-items-center rounded-md border text-xs font-medium">Continue with Google</div>
                {branding.showPoweredBy ? (
                  <p className="pt-1 text-center text-[10px] text-muted-foreground">Powered by OrbitID</p>
                ) : null}
              </div>
            </Card>
          </div>
          <p className="text-xs text-muted-foreground">
            Preview uses the current draft branding. Save to apply it to the hosted Frontend API pages.
          </p>
        </div>
      </div>

      {errors.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Fix the following before saving</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <SaveBar dirty={editor.dirty} saving={editor.saving} disabled={errors.length > 0} onSave={editor.save} onDiscard={editor.reset} />
    </div>
  );
}
