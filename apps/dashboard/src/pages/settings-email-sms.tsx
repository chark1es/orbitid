import { useState } from "react";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { CircleCheck, CircleX, Loader2, Mail, Send } from "lucide-react";
import { api } from "../lib/api";
import {
  EMAIL_PROVIDER_LABELS,
  emailFromError,
  emailProviderLabel,
  errorMessage,
  isHttpUrl,
  resendApiKeyError,
  resolveEmailProvider,
  secretInputValue,
  secretIsConfigured,
  smtpUrlError,
} from "./_config/settings";
import {
  ErrorAlert,
  Field,
  LoadingPage,
  MetaChip,
  Notice,
  PageHeader,
  SaveBar,
  SecretInput,
  SettingsSection,
  SwitchRow,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

type TestState =
  | { state: "idle" }
  | { state: "sending" }
  | { state: "ok"; to: string; provider: string }
  | { state: "error"; to: string; message: string };

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;
  const [testEmail, setTestEmail] = useState("");
  const [test, setTest] = useState<TestState>({ state: "idle" });

  if (editor.isLoading) return <LoadingPage rows={4} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="Email & SMS" description="Application identity, email delivery, verification codes, and SMS." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
      </div>
    );
  }

  const app = settings.application;
  const email = settings.email;
  const sms = settings.sms;
  const resolved = resolveEmailProvider(email);
  const resendConfigured = secretIsConfigured(email.resendApiKey);
  const smtpConfigured = secretIsConfigured(email.smtpUrl);
  const twilioSecretConfigured = secretIsConfigured(sms.twilioAuthToken);
  const fromError = resolved.provider === "console" ? null : emailFromError(email.from);
  const errors: string[] = [];
  if (!isHttpUrl(app.homeUrl)) errors.push("Home URL must be an http(s) URL.");
  if (app.termsUrl && !isHttpUrl(app.termsUrl)) errors.push("Terms URL must be an http(s) URL.");
  if (app.privacyUrl && !isHttpUrl(app.privacyUrl)) errors.push("Privacy URL must be an http(s) URL.");
  if (app.logoUrl && !isHttpUrl(app.logoUrl)) errors.push("Logo URL must be an http(s) URL.");
  if (fromError) errors.push(fromError);
  const emailAttribute = settings.attributes.emailAddress;
  if (resolved.provider === "console" && emailAttribute.enabled && (emailAttribute.usedForFirstFactor || emailAttribute.usedForSecondFactor || emailAttribute.verifyAtSignUp)) errors.push("Configure Resend or SMTP before enabling email sign-in or verification.");
  const phoneAttribute = settings.attributes.phoneNumber;
  if (sms.provider === "console" && phoneAttribute.enabled && (phoneAttribute.usedForFirstFactor || phoneAttribute.usedForSecondFactor || phoneAttribute.verifyAtSignUp)) errors.push("Configure Twilio or an SMS webhook before enabling phone sign-in or verification.");
  if (email.codeLength < 4 || email.codeLength > 10) errors.push("Verification codes must be 4 to 10 digits.");
  if (email.codeLifetimeSeconds <= 0) errors.push("Code lifetime must be greater than zero.");
  if (email.linkLifetimeSeconds <= 0) errors.push("Magic link lifetime must be greater than zero.");
  // The secret fields start blank while a stored value is kept, so an empty draft means "unchanged".
  const smtpError = smtpUrlError(email.smtpUrl);
  if (smtpError) errors.push(smtpError);
  const resendError = resendApiKeyError(email.resendApiKey);
  if (resendError) errors.push(resendError);
  if (resolved.missing === "resendApiKey") errors.push("Resend is selected but no API key is stored. Add a key or choose another provider.");
  if (resolved.missing === "smtpUrl") errors.push("SMTP is selected but no SMTP URL is stored. Add a URL or choose another provider.");
  if (sms.provider === "twilio" && (!sms.twilioAccountSid || !sms.twilioFrom)) errors.push("Twilio Account SID and sender number are required.");
  if (sms.provider === "twilio" && !twilioSecretConfigured) errors.push("Twilio auth token is required.");
  if (sms.provider === "webhook" && !isHttpUrl(sms.webhookUrl)) errors.push("SMS webhook URL must be an http(s) URL.");

  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const sendTest = async () => {
    if (resolved.provider === "console") return;
    const to = testEmail.trim();
    if (!to) {
      setTest({ state: "error", to, message: "Enter an email address to send the test to." });
      return;
    }
    setTest({ state: "sending" });
    try {
      // `email_test` reports the transport it used; failures come back with a redacted, safe message.
      const response = await api<{ provider?: string }>("POST", "/instance/email_test", { to });
      setTest({ state: "ok", to, provider: response?.provider ?? resolved.provider });
    } catch (error) {
      setTest({ state: "error", to, message: errorMessage(error) });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Email & SMS"
        description="Branding shown in emails, how mail leaves the server, code lifetimes, and SMS delivery."
        badge={<MetaChip>Instance settings</MetaChip>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection title="Application identity" description="Shown on hosted pages and in outbound email.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Application name" htmlFor="application-name" required>
            <Input id="application-name" value={app.name} onChange={(event) => editor.patch({ application: { name: event.target.value } })} />
          </Field>
          <Field label="Logo URL" htmlFor="application-logo" description="Square SVG or PNG, 256 by 256 pixels works well.">
            <Input
              id="application-logo"
              value={app.logoUrl ?? ""}
              onChange={(event) => editor.patch({ application: { logoUrl: event.target.value || null } })}
              placeholder="https://example.com/logo.png"
              className="font-data text-xs"
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
            <Input
              id="application-home"
              value={app.homeUrl}
              onChange={(event) => editor.patch({ application: { homeUrl: event.target.value } })}
              className="font-data text-xs"
            />
          </Field>
          <Field label="Terms of service URL" htmlFor="application-terms">
            <Input
              id="application-terms"
              value={app.termsUrl ?? ""}
              onChange={(event) => editor.patch({ application: { termsUrl: event.target.value || null } })}
              placeholder="https://example.com/terms"
              className="font-data text-xs"
            />
          </Field>
          <Field label="Privacy policy URL" htmlFor="application-privacy">
            <Input
              id="application-privacy"
              value={app.privacyUrl ?? ""}
              onChange={(event) => editor.patch({ application: { privacyUrl: event.target.value || null } })}
              placeholder="https://example.com/privacy"
              className="font-data text-xs"
            />
          </Field>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Email delivery"
        description="How sign-in codes, magic links and invitations leave the server. Credentials are stored with the instance and never shown again."
        actions={<MetaChip>{EMAIL_PROVIDER_LABELS[resolved.provider]}</MetaChip>}
      >
        <Field
          label="Provider"
          htmlFor="email-provider"
          description="Automatic uses Resend when a key is set, then SMTP when a URL is set, otherwise delivery stays disabled."
          className="max-w-md"
        >
          <Select
            value={email.provider}
            onValueChange={(provider) => editor.patch({ email: { provider: provider as typeof email.provider } })}
          >
            <SelectTrigger id="email-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic</SelectItem>
              <SelectItem value="resend">Resend</SelectItem>
              <SelectItem value="smtp">SMTP</SelectItem>
              <SelectItem value="console">Not configured</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground" role="status">
          {resolved.automatic ? "Automatic: " : "Selected: "}
          <span className="font-medium text-foreground">{EMAIL_PROVIDER_LABELS[resolved.provider]}</span>
          {resolved.provider === "resend" ? " sends over HTTPS with the stored API key." : null}
          {resolved.provider === "smtp" ? " sends through the stored SMTP server." : null}
          {resolved.provider === "console" ? " refuses delivery until a provider is configured." : null}
        </p>

        {resolved.provider === "console" ? (
          <Notice
            tone="caution"
            role="alert"
            title="Email delivery is not configured"
          >
            <p>Choose Resend or SMTP and add the required credentials. Sign-in codes and magic links are never written to logs or files.</p>
          </Notice>
        ) : null}

        {resolved.missing ? (
          <Notice tone="danger" role="alert" title={resolved.missing === "resendApiKey" ? "Resend has no API key" : "SMTP has no URL"}>
            <p>
              Sends fail with a 422 until this is fixed. Add the value below or pick Automatic so the server falls back to
              another transport.
            </p>
          </Notice>
        ) : null}

        {resolved.provider !== "console" ? <Field
          label="From address"
          htmlFor="email-from"
          required
          error={fromError}
          description="Mailbox in RFC 5322 form, for example OrbitID <no-reply@example.com>. Use a domain your provider has verified."
        >
          <Input
            id="email-from"
            value={email.from}
            onChange={(event) => editor.patch({ email: { from: event.target.value } })}
            aria-invalid={Boolean(fromError)}
          />
        </Field> : null}

        {email.provider === "resend" || email.provider === "auto" ? (
          <SecretInput
            id="email-resend"
            label="Resend API key"
            value={secretInputValue(email.resendApiKey)}
            onChange={(resendApiKey) => editor.patch({ email: { resendApiKey } })}
            configured={resendConfigured}
            description={
              resendConfigured
                ? "A key is stored. Enter a new key to replace it, or leave blank to keep it."
                : "Create a key in Resend for the domain you send from. Starts with re_."
            }
            placeholder={resendConfigured ? "Stored key, leave blank to keep" : "re_xxxxxxxx"}
          />
        ) : null}

        {email.provider === "smtp" || email.provider === "auto" ? (
          <SecretInput
            id="email-smtp"
            label="SMTP URL"
            value={secretInputValue(email.smtpUrl)}
            onChange={(smtpUrl) => editor.patch({ email: { smtpUrl } })}
            configured={smtpConfigured}
            description={
              smtpConfigured
                ? "A URL is stored. smtp:// uses STARTTLS, smtps:// uses TLS on port 465. Leave blank to keep it."
                : "smtp://user:password@host:587 or smtps://user:password@host:465. Percent-encode special characters."
            }
            placeholder={smtpConfigured ? "Stored SMTP URL, leave blank to keep" : "smtp://user:pass@mail.example.com:587"}
          />
        ) : null}

        {resolved.provider !== "console" ? <div className="space-y-2 border-t border-border pt-3">
          <div>
            <p className="text-sm font-medium">Send a test email</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Sends one real message through the saved settings, not the draft on this page. Save first if you just changed
              the provider.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="email"
              value={testEmail}
              onChange={(event) => setTestEmail(event.target.value)}
              placeholder="you@example.com"
              aria-label="Test recipient"
            />
            <Button variant="outline" onClick={() => void sendTest()} disabled={test.state === "sending"}>
              {test.state === "sending" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
              {test.state === "sending" ? "Sending…" : "Send test email"}
            </Button>
          </div>
          {test.state === "ok" ? (
            <p role="status" className="flex items-start gap-2 text-[0.8125rem] leading-relaxed">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-go" strokeWidth={1.5} aria-hidden />
              <span>
                Delivered to <span className="font-data text-xs">{test.to}</span> through{" "}
                <span className="font-medium">{emailProviderLabel(test.provider)}</span>. Check the inbox and the spam
                folder.
              </span>
            </p>
          ) : null}
          {test.state === "error" ? (
            <p role="alert" className="flex items-start gap-2 text-[0.8125rem] leading-relaxed">
              <CircleX className="mt-0.5 size-4 shrink-0 text-signal" strokeWidth={1.5} aria-hidden />
              <span>
                <span className="font-medium">The test email was not delivered.</span> {test.message} The server redacts
                credentials from this message, so it is safe to share.
              </span>
            </p>
          ) : null}
        </div> : null}

        <div className="grid gap-4 border-t border-border pt-3 sm:grid-cols-3">
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
      </SettingsSection>

      <SettingsSection title="SMS" description="SMS codes for phone verification, sign-in, and second factors.">
        <Field label="SMS provider" htmlFor="sms-provider" className="max-w-md">
          <Select value={sms.provider} onValueChange={(provider) => editor.patch({ sms: { provider } })}>
            <SelectTrigger id="sms-provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="console">Not configured</SelectItem>
              <SelectItem value="twilio">Twilio</SelectItem>
              <SelectItem value="webhook">Webhook</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {sms.provider === "twilio" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Account SID" htmlFor="twilio-sid">
              <Input
                id="twilio-sid"
                value={sms.twilioAccountSid}
                onChange={(event) => editor.patch({ sms: { twilioAccountSid: event.target.value } })}
                placeholder="ACxxxxxxxx"
                className="font-data text-xs"
              />
            </Field>
            <SecretInput
              id="twilio-token"
              label="Auth token"
              value={secretInputValue(sms.twilioAuthToken)}
              onChange={(twilioAuthToken) => editor.patch({ sms: { twilioAuthToken } })}
              configured={twilioSecretConfigured}
              description={twilioSecretConfigured ? "A token is stored. Leave blank to keep it." : "Found next to the Account SID."}
              placeholder={twilioSecretConfigured ? "Stored token, leave blank to keep" : "Auth token"}
            />
            <Field label="Sender number" htmlFor="twilio-from">
              <Input
                id="twilio-from"
                value={sms.twilioFrom}
                onChange={(event) => editor.patch({ sms: { twilioFrom: event.target.value } })}
                placeholder="+15551234567"
                className="font-data text-xs"
              />
            </Field>
          </div>
        ) : null}
        {sms.provider === "webhook" ? (
          <Field label="Webhook URL" htmlFor="sms-webhook" description="OrbitID posts { to, body } to this URL.">
            <Input
              id="sms-webhook"
              value={sms.webhookUrl}
              onChange={(event) => editor.patch({ sms: { webhookUrl: event.target.value } })}
              placeholder="https://example.com/sms"
              className="font-data text-xs"
            />
          </Field>
        ) : null}
        {sms.provider === "console" ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            SMS delivery is disabled. Configure Twilio or an SMS webhook before enabling phone verification or sign-in.
          </p>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Application home" description="Where hosted links and the sign-in redirect land.">
        <SwitchRow
          label="Development mode"
          description="Allows localhost origins and logs more diagnostic detail. Turn it off in production."
          checked={app.developmentMode}
          onCheckedChange={(developmentMode) => editor.patch({ application: { developmentMode } })}
        />
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Mail className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          Delivery behaviour and every provider field are documented in <code className="font-data">docs/EMAIL.md</code>.
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
