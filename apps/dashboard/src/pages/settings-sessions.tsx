import { useEffect, useRef, useState } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Input,
} from "@orbitid/ui";
import {
  SESSION_SHORTCODES,
  formatJson,
  humanDuration,
  insertAtCursor,
  parseJsonRecord,
} from "./_config/settings";
import {
  ErrorAlert,
  Field,
  JsonEditor,
  LoadingPage,
  MetaChip,
  PageHeader,
  SaveBar,
  SettingsSection,
  SwitchRow,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [claimsText, setClaimsText] = useState("{}");
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const claimsRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!settings) return;
    setClaimsText(formatJson(settings.session.customClaims));
    setClaimsError(null);
    // Resync the JSON draft after load, save, or discard.
  }, [editor.revision]);

  if (editor.isLoading) return <LoadingPage rows={3} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Sessions" description="Session lifetime, token refresh, and custom session token claims." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const errors: string[] = [];
  if (settings.session.lifetimeSeconds <= 0) errors.push("Session lifetime must be greater than zero.");
  if (settings.session.inactivityTimeoutSeconds < 0) errors.push("Inactivity timeout cannot be negative.");
  if (settings.session.tokenLifetimeSeconds <= 0) errors.push("Token lifetime must be greater than zero.");
  if (settings.session.inactivityTimeoutSeconds > 0 && settings.session.inactivityTimeoutSeconds > settings.session.lifetimeSeconds)
    errors.push("Inactivity timeout cannot exceed the session lifetime.");
  if (settings.session.trustedDevicesEnabled && (settings.session.trustedDeviceDays < 1 || settings.session.trustedDeviceDays > 365))
    errors.push("Trusted device duration must be between 1 and 365 days.");
  if (claimsError) errors.push("Custom claims are not valid JSON.");

  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const updateClaims = (text: string) => {
    setClaimsText(text);
    const parsed = parseJsonRecord(text);
    if (parsed.error) {
      setClaimsError(parsed.error);
      return;
    }
    setClaimsError(null);
    editor.patch({ session: { customClaims: parsed.value } });
  };

  const insertShortcode = (shortcode: string) => {
    const next = insertAtCursor(claimsText, shortcode, claimsRef.current?.selectionStart ?? null, claimsRef.current?.selectionEnd ?? null);
    updateClaims(next.value);
    requestAnimationFrame(() => {
      claimsRef.current?.focus();
      claimsRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sessions"
        description="Control how long sessions last, how often tokens refresh, and which custom claims session JWTs carry."
        badge={<MetaChip>Instance settings</MetaChip>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection title="Session lifetime" description="A session expires at the maximum lifetime even while it is in use.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Maximum session lifetime (seconds)"
            htmlFor="session-lifetime"
            description={`Currently ${humanDuration(settings.session.lifetimeSeconds)}.`}
          >
            <Input
              id="session-lifetime"
              type="number"
              min={1}
              value={settings.session.lifetimeSeconds}
              onChange={(event) => editor.patch({ session: { lifetimeSeconds: number(event.target.value) } })}
            />
          </Field>
          <Field
            label="Inactivity timeout (seconds)"
            htmlFor="session-inactivity"
            description={
              settings.session.inactivityTimeoutSeconds > 0
                ? `Sessions expire after ${humanDuration(settings.session.inactivityTimeoutSeconds)} without activity.`
                : "0 disables the inactivity timeout."
            }
          >
            <Input
              id="session-inactivity"
              type="number"
              min={0}
              value={settings.session.inactivityTimeoutSeconds}
              onChange={(event) => editor.patch({ session: { inactivityTimeoutSeconds: number(event.target.value) } })}
            />
          </Field>
          <Field
            label="Session token lifetime (seconds)"
            htmlFor="session-token-lifetime"
            description={`The SDK refreshes tokens on this cadence. ${humanDuration(settings.session.tokenLifetimeSeconds)}; 60 seconds is recommended.`}
          >
            <Input
              id="session-token-lifetime"
              type="number"
              min={1}
              value={settings.session.tokenLifetimeSeconds}
              onChange={(event) => editor.patch({ session: { tokenLifetimeSeconds: number(event.target.value) } })}
            />
          </Field>
        </div>
        <SwitchRow
          label="Multi-session mode"
          description="Allow multiple sessions per client, for example two accounts in one browser."
          checked={settings.session.multiSession}
          onCheckedChange={(multiSession) => editor.patch({ session: { multiSession } })}
        />
        <dl className="grid gap-x-8 gap-y-2 border-t border-border pt-3 sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-xs text-muted-foreground">Effective lifetime</dt>
            <dd className="font-data text-xs font-medium">{humanDuration(settings.session.lifetimeSeconds)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-xs text-muted-foreground">Refresh cadence</dt>
            <dd className="font-data text-xs font-medium">Every {humanDuration(settings.session.tokenLifetimeSeconds)}</dd>
          </div>
        </dl>
      </SettingsSection>

      <SettingsSection
        title="Trusted devices"
        description="Let a user skip the second factor on a browser they have marked as trusted, until the trust expires."
      >
        <SwitchRow
          label="Allow trusted devices"
          description="A user can remember this browser after a successful second factor, so the next sign-in asks for the password only."
          checked={settings.session.trustedDevicesEnabled}
          onCheckedChange={(trustedDevicesEnabled) => editor.patch({ session: { trustedDevicesEnabled } })}
        />
        <Field
          label="Trust duration (days)"
          htmlFor="trusted-device-days"
          description="How long a remembered browser keeps skipping the second factor. Turning the feature off keeps but ignores the records."
          className="max-w-md"
        >
          <Input
            id="trusted-device-days"
            type="number"
            min={1}
            max={365}
            value={settings.session.trustedDeviceDays}
            disabled={!settings.session.trustedDevicesEnabled}
            onChange={(event) => editor.patch({ session: { trustedDeviceDays: number(event.target.value) } })}
          />
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Custom session token claims"
        description="Claims merged into every session JWT. Shortcodes resolve per user and organization when the token is minted."
      >
        <Field label="Claims (JSON)">
          <JsonEditor
            ref={claimsRef}
            value={claimsText}
            onChange={updateClaims}
            error={claimsError}
            placeholder={'{\n  "email": "{{user.primary_email_address}}",\n  "org": "{{org.slug}}"\n}'}
            aria-label="Custom session claims"
          />
        </Field>
        <Accordion type="single" collapsible>
          <AccordionItem value="shortcodes">
            <AccordionTrigger className="text-sm">Shortcode reference, click to insert</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {SESSION_SHORTCODES.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => insertShortcode(item.code)}
                    className="flex items-center justify-between gap-2 border border-border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <code className="font-data">{item.code}</code>
                    <span className="truncate text-muted-foreground">{item.description}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                A claim that is exactly one shortcode keeps its JSON type. Embedded shortcodes become strings. Use{" "}
                <code>{"{{a}} || {{b}}"}</code> to fall back when the first value is empty.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Reverification uses <code>factor_verification_age</code> on the session. Applications can require a fresh first or second factor
          with <code>has({"{ reverification: ... }"})</code>. An expired verification does not end the session.
        </p>
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
