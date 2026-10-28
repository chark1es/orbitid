import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle, Accordion, AccordionContent, AccordionItem, AccordionTrigger, Badge, Input } from "@orbitid/ui";
import { Info } from "lucide-react";
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
  PageHeader,
  SaveBar,
  SectionCard,
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
        <ErrorAlert error={editor.error ?? "Could not load instance settings."} onRetry={editor.refetch} />
      </div>
    );
  }

  const errors: string[] = [];
  if (settings.session.lifetimeSeconds <= 0) errors.push("Session lifetime must be greater than zero.");
  if (settings.session.inactivityTimeoutSeconds < 0) errors.push("Inactivity timeout cannot be negative.");
  if (settings.session.tokenLifetimeSeconds <= 0) errors.push("Token lifetime must be greater than zero.");
  if (settings.session.inactivityTimeoutSeconds > 0 && settings.session.inactivityTimeoutSeconds > settings.session.lifetimeSeconds)
    errors.push("Inactivity timeout cannot exceed the session lifetime.");
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
        description="Control how long sessions last, how token refresh works, and which custom claims are added to session JWTs."
        badge={<Badge variant="outline">Instance settings</Badge>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SectionCard title="Session lifetime" description="Sessions expire after the maximum lifetime even while active.">
        <div className="grid gap-3 sm:grid-cols-2">
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
            description={`JWTs are refreshed by the SDK. ${humanDuration(settings.session.tokenLifetimeSeconds)}; 60 seconds is recommended.`}
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
          description="Allow multiple sessions per client (for example, multiple accounts in one browser)."
          checked={settings.session.multiSession}
          onCheckedChange={(multiSession) => editor.patch({ session: { multiSession } })}
        />
      </SectionCard>

      <SectionCard
        title="Custom session token claims"
        description="Claims merged into every session JWT. Shortcodes are resolved per user and organization at mint time."
      >
        <JsonEditor
          ref={claimsRef}
          value={claimsText}
          onChange={updateClaims}
          error={claimsError}
          placeholder='{\n  "email": "{{user.primary_email_address}}",\n  "org": "{{org.slug}}"\n}'
        />
        <Accordion type="single" collapsible>
          <AccordionItem value="shortcodes">
            <AccordionTrigger className="text-sm">Shortcode reference — click to insert</AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {SESSION_SHORTCODES.map((item) => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => insertShortcode(item.code)}
                    className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    <code className="font-mono">{item.code}</code>
                    <span className="truncate text-muted-foreground">{item.description}</span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Whole-value shortcodes keep their JSON type; embedded shortcodes are stringified. Use <code>{"{{a}} || {{b}}"}</code> for a fallback.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SectionCard>

      <Alert>
        <Info />
        <AlertTitle>Reverification</AlertTitle>
        <AlertDescription>
          Reverification decisions use <code>factor_verification_age</code> on the session. Applications can require a fresh first or second
          factor with <code>has({"{ reverification: ... }"})</code>; expired verification does not end the session.
        </AlertDescription>
      </Alert>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border px-3 py-2">
          <p className="text-xs text-muted-foreground">Effective lifetime</p>
          <p className="text-sm font-medium">{humanDuration(settings.session.lifetimeSeconds)}</p>
        </div>
        <div className="rounded-lg border px-3 py-2">
          <p className="text-xs text-muted-foreground">Refresh cadence</p>
          <p className="text-sm font-medium">Every {humanDuration(settings.session.tokenLifetimeSeconds)}</p>
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
