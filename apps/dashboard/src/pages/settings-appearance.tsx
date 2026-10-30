import { useEffect, useState } from "react";
import {
  cn,
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

type PreviewScheme = "light" | "dark";

/** Follows the operating system's color scheme, for a branding theme of "system". */
function useSystemScheme(): PreviewScheme {
  const [scheme, setScheme] = useState<PreviewScheme>(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setScheme(query.matches ? "dark" : "light");
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return scheme;
}

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `<input type="color">` only accepts `#rrggbb`; the text field also takes `#rgb` and `#rrggbbaa`. */
function toPickerValue(hex: string): string {
  const digits = hex.replace("#", "");
  if (digits.length === 3) return `#${digits.split("").map((d) => d + d).join("")}`;
  return `#${digits.slice(0, 6)}`;
}

/** Black or white, whichever reads better on the chosen brand color (hex, 3 or 6 digits). */
function readableInk(hex: string): string {
  const digits = hex.replace("#", "");
  const full = digits.length === 3 ? digits.split("").map((d) => d + d).join("") : digits;
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.18 ? "#111111" : "#ffffff";
}

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const systemScheme = useSystemScheme();
  // The operator can flip the preview without touching the saved theme; picking a theme resets the flip.
  const [schemeOverride, setSchemeOverride] = useState<PreviewScheme | null>(null);

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
  const previewInk = readableInk(previewColor);
  const configuredScheme: PreviewScheme = branding.theme === "system" ? systemScheme : branding.theme;
  const previewScheme = schemeOverride ?? configuredScheme;
  // A dark brand color would vanish on the dark surface, so the hosted components fall back to the theme's primary there.
  const brandVanishes = previewScheme === "dark" && previewInk === "#ffffff";
  const brandFill = brandVanishes ? "var(--primary)" : previewColor;
  const brandText = brandVanishes ? "var(--primary-foreground)" : previewInk;

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
                value={toPickerValue(previewColor)}
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
            <Select value={branding.theme} onValueChange={(theme) => {
                setSchemeOverride(null);
                editor.patch({ branding: { theme } });
              }}
            >
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
            <div className="flex items-center gap-3">
              <p className="hidden text-xs text-muted-foreground sm:block">Current draft, before saving</p>
              <div role="group" aria-label="Preview color scheme" className="inline-flex border border-border">
                {(["light", "dark"] as const).map((scheme) => (
                  <button
                    key={scheme}
                    type="button"
                    aria-pressed={previewScheme === scheme}
                    onClick={() => setSchemeOverride(scheme === configuredScheme ? null : scheme)}
                    className="px-2.5 py-1 text-xs font-medium capitalize text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent aria-pressed:text-foreground"
                  >
                    {scheme}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div
            data-testid="branding-preview"
            data-scheme={previewScheme}
            className={cn(
              "border border-border bg-muted/30 p-6 text-foreground transition-colors duration-200 motion-reduce:transition-none",
              previewScheme === "dark" ? "dark bg-background" : "light",
            )}
          >
            <div className="mx-auto w-full max-w-sm border border-border bg-card px-6 py-7">
              <div className="space-y-1 text-center">
                <div
                  className="mx-auto grid size-9 place-items-center text-sm font-semibold"
                  style={{ backgroundColor: brandFill, color: brandText }}
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
                  className="grid h-[34px] place-items-center text-xs font-medium"
                  style={{ backgroundColor: brandFill, color: brandText }}
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
        <Field label="Allowed redirect origins" description="Origins a browser may be sent to after sign-in. They are not allowed to call this API; list apps that do under Allowed origins.">
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
