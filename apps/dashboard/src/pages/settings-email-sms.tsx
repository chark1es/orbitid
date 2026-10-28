import { useState } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { Loader2, Mail, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { errorMessage, isHttpUrl, secretInputValue, secretIsConfigured } from "./_config/settings";
import { ErrorAlert, Field, LoadingPage, PageHeader, SaveBar, SectionCard, SwitchRow } from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [testEmail, setTestEmail] = useState("");
  const [sending, setSending] = useState(false);

  if (editor.isLoading) return <LoadingPage rows={4} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Email & SMS" description="Application identity, email delivery, verification codes, and SMS." />
        <ErrorAlert error={editor.error ?? "Could not load instance settings."} onRetry={editor.refetch} />
      </div>
    );
  }

  const app = settings.application;
  const email = settings.email;
  const sms = settings.sms;
  const smtpConfigured = secretIsConfigured(email.smtpUrl);
  const twilioSecretConfigured = secretIsConfigured(sms.twilioAuthToken);
  const errors: string[] = [];
  if (!isHttpUrl(app.homeUrl)) errors.push("Home URL must be an http(s) URL.");
  if (app.termsUrl && !isHttpUrl(app.termsUrl)) errors.push("Terms URL must be an http(s) URL.");
  if (app.privacyUrl && !isHttpUrl(app.privacyUrl)) errors.push("Privacy URL must be an http(s) URL.");
  if (app.logoUrl && !isHttpUrl(app.logoUrl)) errors.push("Logo URL must be an http(s) URL.");
  if (email.codeLength < 4 || email.codeLength > 10) errors.push("Verification codes must be 4–10 digits.");
  if (email.codeLifetimeSeconds <= 0) errors.push("Code lifetime must be greater than zero.");
  if (email.linkLifetimeSeconds <= 0) errors.push("Magic link lifetime must be greater than zero.");
  if (sms.provider === "twilio" && (!sms.twilioAccountSid || !sms.twilioFrom)) errors.push("Twilio Account SID and sender number are required.");
  if (sms.provider === "twilio" && !twilioSecretConfigured) errors.push("Twilio auth token is required.");
  if (sms.provider === "webhook" && !isHttpUrl(sms.webhookUrl)) errors.push("SMS webhook URL must be an http(s) URL.");

  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const sendTest = async () => {
    if (!testEmail.trim()) {
      toast.error("Enter an email address first");
      return;
    }
    setSending(true);
    try {
      await api("POST", "/instance/test_email", { to: testEmail.trim() });
      toast.success("Test email queued", { description: `Sent to ${testEmail.trim()}.` });
    } catch (error) {
      toast.error("Could not send test email", { description: errorMessage(error) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email & SMS"
        description="Branding shown in emails, transport configuration, code/link lifetimes, and SMS delivery."
        badge={<Badge variant="outline">Instance settings</Badge>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SectionCard
        title="Application identity"
        description="Shown on hosted pages and in outbound email."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Application name" htmlFor="application-name" required>
            <Input id="application-name" value={app.name} onChange={(event) => editor.patch({ application: { name: event.target.value } })} />
          </Field>
          <Field label="Logo URL" htmlFor="application-logo" description="Square SVG or PNG, ideally 256×256.">
            <Input
              id="application-logo"
              value={app.logoUrl ?? ""}
              onChange={(event) => editor.patch({ application: { logoUrl: event.target.value || null } })}
              placeholder="https://example.com/logo.png"
            />
          </Field>
          <Field label="Support email" htmlFor="application-support">
            <Input
              id="application-support"
              type="email"
              value={app.supportEmail ?? ""}
              onChange={(event) => editor.patch({ application: { supportEmail: event.target.value || null } })}
              placeholder="support@example.com"
            />
          </Field>
          <Field label="Home URL" htmlFor="application-home">
            <Input id="application-home" value={app.homeUrl} onChange={(event) => editor.patch({ application: { homeUrl: event.target.value } })} />
          </Field>
          <Field label="Terms of service URL" htmlFor="application-terms">
            <Input
              id="application-terms"
              value={app.termsUrl ?? ""}
              onChange={(event) => editor.patch({ application: { termsUrl: event.target.value || null } })}
              placeholder="https://example.com/terms"
            />
          </Field>
          <Field label="Privacy policy URL" htmlFor="application-privacy">
            <Input
              id="application-privacy"
              value={app.privacyUrl ?? ""}
              onChange={(event) => editor.patch({ application: { privacyUrl: event.target.value || null } })}
              placeholder="https://example.com/privacy"
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Mail className="size-4" /> Email delivery
          </span>
        }
        description="SMTP transport and the sender address. Empty SMTP URL logs messages to the server console in development."
      >
        <Field label="From address" htmlFor="email-from" description="RFC 5322 mailbox, for example `OrbitID <no-reply@example.com>`.">
          <Input id="email-from" value={email.from} onChange={(event) => editor.patch({ email: { from: event.target.value } })} />
        </Field>
        <Field
          label={
            <span className="flex items-center gap-2">
              SMTP URL
              {smtpConfigured ? <Badge variant="outline">Configured</Badge> : null}
            </span>
          }
          htmlFor="email-smtp"
          description="smtp://user:password@host:587 — leave blank to keep the stored value."
        >
          <Input
            id="email-smtp"
            type="password"
            autoComplete="new-password"
            value={secretInputValue(email.smtpUrl)}
            onChange={(event) => editor.patch({ email: { smtpUrl: event.target.value } })}
            placeholder={smtpConfigured ? "Stored SMTP URL — leave blank to keep" : "smtp://user:pass@localhost:587"}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Code length" htmlFor="email-code-length">
            <Input
              id="email-code-length"
              type="number"
              min={4}
              max={10}
              value={email.codeLength}
              onChange={(event) => editor.patch({ email: { codeLength: number(event.target.value) } })}
            />
          </Field>
          <Field label="Code lifetime (seconds)" htmlFor="email-code-lifetime">
            <Input
              id="email-code-lifetime"
              type="number"
              min={1}
              value={email.codeLifetimeSeconds}
              onChange={(event) => editor.patch({ email: { codeLifetimeSeconds: number(event.target.value) } })}
            />
          </Field>
          <Field label="Magic link lifetime (seconds)" htmlFor="email-link-lifetime">
            <Input
              id="email-link-lifetime"
              type="number"
              min={1}
              value={email.linkLifetimeSeconds}
              onChange={(event) => editor.patch({ email: { linkLifetimeSeconds: number(event.target.value) } })}
            />
          </Field>
        </div>
        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">Send a test email</p>
          <p className="mb-2 text-xs text-muted-foreground">Uses the currently saved SMTP configuration.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="email"
              value={testEmail}
              onChange={(event) => setTestEmail(event.target.value)}
              placeholder="you@example.com"
              aria-label="Test recipient"
            />
            <Button variant="outline" onClick={() => void sendTest()} disabled={sending}>
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
              Send test email
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <MessageSquare className="size-4" /> SMS
          </span>
        }
        description="SMS codes for phone verification, sign-in, and second factors."
      >
        <Field label="SMS provider" htmlFor="sms-provider">
          <Select value={sms.provider} onValueChange={(provider) => editor.patch({ sms: { provider } })}>
            <SelectTrigger id="sms-provider" className="w-full sm:max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="console">Console (development)</SelectItem>
              <SelectItem value="twilio">Twilio</SelectItem>
              <SelectItem value="webhook">Webhook</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {sms.provider === "twilio" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Account SID" htmlFor="twilio-sid">
              <Input
                id="twilio-sid"
                value={sms.twilioAccountSid}
                onChange={(event) => editor.patch({ sms: { twilioAccountSid: event.target.value } })}
                placeholder="ACxxxxxxxx"
              />
            </Field>
            <Field
              label={
                <span className="flex items-center gap-2">
                  Auth token
                  {twilioSecretConfigured ? <Badge variant="outline">Configured</Badge> : null}
                </span>
              }
              htmlFor="twilio-token"
              description="Leave blank to keep the stored token."
            >
              <Input
                id="twilio-token"
                type="password"
                autoComplete="new-password"
                value={secretInputValue(sms.twilioAuthToken)}
                onChange={(event) => editor.patch({ sms: { twilioAuthToken: event.target.value } })}
                placeholder={twilioSecretConfigured ? "Stored token — leave blank to keep" : "Auth token"}
              />
            </Field>
            <Field label="Sender number" htmlFor="twilio-from">
              <Input
                id="twilio-from"
                value={sms.twilioFrom}
                onChange={(event) => editor.patch({ sms: { twilioFrom: event.target.value } })}
                placeholder="+15551234567"
              />
            </Field>
          </div>
        ) : null}
        {sms.provider === "webhook" ? (
          <Field label="Webhook URL" htmlFor="sms-webhook" description="POST { to, body } to this URL.">
            <Input
              id="sms-webhook"
              value={sms.webhookUrl}
              onChange={(event) => editor.patch({ sms: { webhookUrl: event.target.value } })}
              placeholder="https://example.com/sms"
            />
          </Field>
        ) : null}
        {sms.provider === "console" ? (
          <Alert>
            <AlertTitle>Console provider</AlertTitle>
            <AlertDescription>Messages are written to the server log. Use Twilio or a webhook in production.</AlertDescription>
          </Alert>
        ) : null}
      </SectionCard>

      <SectionCard title="Application home" description="Where hosted links and the sign-in redirect land.">
        <SwitchRow
          label="Development mode"
          description="Allows localhost origins and logs more diagnostic detail."
          checked={app.developmentMode}
          onCheckedChange={(developmentMode) => editor.patch({ application: { developmentMode } })}
        />
      </SectionCard>

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
