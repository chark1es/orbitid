import type { AttributeConfig } from "@orbitid/shared";
import { Alert, AlertDescription, AlertTitle, Badge, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch } from "@orbitid/ui";
import { KeyRound, Lock, ShieldCheck } from "lucide-react";
import {
  CheckboxRow,
  ErrorAlert,
  Field,
  LoadingPage,
  PageHeader,
  SaveBar,
  SectionCard,
  SwitchRow,
} from "./_config/ui";
import { secretInputValue, secretIsConfigured } from "./_config/settings";
import { useSettingsEditor } from "./_config/use-settings";

const ATTRIBUTE_KEYS = ["emailAddress", "phoneNumber", "username", "firstName", "lastName", "password", "passkey", "backupCode", "authenticatorApp"] as const;
type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

function AttributeCard({
  title,
  description,
  config,
  onChange,
  verificationOptions,
  showVerification = true,
  showVerifyAtSignUp = true,
}: {
  title: string;
  description: string;
  config: AttributeConfig;
  onChange: (patch: Partial<AttributeConfig>) => void;
  verificationOptions?: { value: string; label: string }[];
  showVerification?: boolean;
  showVerifyAtSignUp?: boolean;
}) {
  const disabled = !config.enabled;
  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          {title}
          <Badge variant={config.enabled ? "default" : "secondary"}>{config.enabled ? "On" : "Off"}</Badge>
        </span>
      }
      description={description}
      actions={<Switch checked={config.enabled} onCheckedChange={(enabled) => onChange({ enabled })} aria-label={`Enable ${title}`} />}
      className="gap-3"
    >
      <div className={disabled ? "space-y-3 opacity-60" : "space-y-3"}>
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckboxRow
            label="Required"
            description="Users must supply this attribute at sign-up."
            checked={config.required}
            disabled={disabled}
            onCheckedChange={(required) => onChange({ required })}
          />
          <CheckboxRow
            label="Used for sign-in"
            description="Identifier accepted by the sign-in form."
            checked={config.usedForFirstFactor}
            disabled={disabled}
            onCheckedChange={(usedForFirstFactor) => onChange({ usedForFirstFactor })}
          />
          {showVerifyAtSignUp ? (
            <CheckboxRow
              label="Verify at sign-up"
              description="Require verification before the sign-up completes."
              checked={config.verifyAtSignUp}
              disabled={disabled}
              onCheckedChange={(verifyAtSignUp) => onChange({ verifyAtSignUp })}
            />
          ) : null}
        </div>
        {showVerification && verificationOptions?.length ? (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">Verification methods</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {verificationOptions.map((option) => (
                <CheckboxRow
                  key={option.value}
                  label={option.label}
                  checked={config.verifications.includes(option.value)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange({
                      verifications: checked
                        ? [...config.verifications, option.value]
                        : config.verifications.filter((value) => value !== option.value),
                    })
                  }
                />
              ))}
            </div>
            {config.verifications.length === 0 ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No verification method selected — users will not be able to verify this attribute.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;

  if (editor.isLoading) return <LoadingPage rows={4} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="User & Authentication" description="Configure identifiers, password policy, MFA, and abuse protection." />
        <ErrorAlert error={editor.error ?? "Could not load instance settings."} onRetry={editor.refetch} />
      </div>
    );
  }

  const errors: string[] = [];
  if (settings.password.minLength < 1) errors.push("Password minimum length must be at least 1.");
  if (settings.password.maxLength < settings.password.minLength) errors.push("Password maximum length must be at least the minimum length.");
  if (settings.username.minLength < 1) errors.push("Username minimum length must be at least 1.");
  if (settings.username.maxLength < settings.username.minLength) errors.push("Username maximum length must be at least the minimum length.");
  if (settings.mfa.maxAttempts < 1) errors.push("MFA attempt limit must be at least 1.");
  if (settings.mfa.lockoutDurationSeconds < 0) errors.push("Lockout duration cannot be negative.");
  if (settings.security.captchaProvider !== "none" && settings.security.botProtection && !settings.security.captchaSiteKey)
    errors.push("Add a captcha site key when bot protection is enabled.");
  if (settings.security.captchaProvider !== "none" && settings.security.botProtection && !secretIsConfigured(settings.security.captchaSecret))
    errors.push("Add a captcha secret when bot protection is enabled.");

  const updateAttribute = (key: AttributeKey, patch: Partial<AttributeConfig>) => {
    editor.patch({ attributes: { [key]: patch } });
  };
  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const captchaSecretConfigured = secretIsConfigured(settings.security.captchaSecret);
  const hasSecondFactor =
    settings.attributes.authenticatorApp.enabled || settings.attributes.backupCode.enabled || settings.attributes.phoneNumber.usedForSecondFactor;
  if (settings.mfa.required && !hasSecondFactor) errors.push("Enable at least one second factor before requiring MFA.");

  return (
    <div className="space-y-6">
      <PageHeader
        title="User & Authentication"
        description="Choose how users identify themselves, how passwords are enforced, and which second factors are available."
        badge={<Badge variant="outline">Instance settings</Badge>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SectionCard
        title="Identifiers"
        description="Each identifier can be enabled, required, and used on the sign-in form. Verification methods apply to sign-up and sign-in."
      >
        <div className="grid gap-3 lg:grid-cols-2">
          <AttributeCard
            title="Email address"
            description="Primary identifier for most applications."
            config={settings.attributes.emailAddress}
            onChange={(patch) => updateAttribute("emailAddress", patch)}
            verificationOptions={[
              { value: "email_code", label: "Email code" },
              { value: "email_link", label: "Email link" },
            ]}
          />
          <AttributeCard
            title="Phone number"
            description="SMS-based sign-in and verification."
            config={settings.attributes.phoneNumber}
            onChange={(patch) => updateAttribute("phoneNumber", patch)}
            verificationOptions={[{ value: "phone_code", label: "SMS code" }]}
          />
          <AttributeCard
            title="Username"
            description="A unique handle users can sign in with."
            config={settings.attributes.username}
            onChange={(patch) => updateAttribute("username", patch)}
            showVerification={false}
            showVerifyAtSignUp={false}
          />
        </div>
        {settings.attributes.username.enabled ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Username minimum length" htmlFor="username-min">
              <Input
                id="username-min"
                type="number"
                min={1}
                value={settings.username.minLength}
                onChange={(event) => editor.patch({ username: { minLength: number(event.target.value) } })}
              />
            </Field>
            <Field label="Username maximum length" htmlFor="username-max">
              <Input
                id="username-max"
                type="number"
                min={1}
                value={settings.username.maxLength}
                onChange={(event) => editor.patch({ username: { maxLength: number(event.target.value) } })}
              />
            </Field>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Lock className="size-4" /> Password
          </span>
        }
        description="Password authentication and complexity requirements."
        actions={<Badge variant={settings.attributes.password.enabled ? "default" : "secondary"}>{settings.attributes.password.enabled ? "Enabled" : "Disabled"}</Badge>}
      >
        <SwitchRow
          label="Allow password sign-in"
          description="Disable to force passwordless or social sign-in."
          checked={settings.attributes.password.enabled}
          onCheckedChange={(enabled) => updateAttribute("password", { enabled })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Minimum length" htmlFor="password-min">
            <Input
              id="password-min"
              type="number"
              min={1}
              value={settings.password.minLength}
              onChange={(event) => editor.patch({ password: { minLength: number(event.target.value) } })}
            />
          </Field>
          <Field label="Maximum length" htmlFor="password-max">
            <Input
              id="password-max"
              type="number"
              min={1}
              value={settings.password.maxLength}
              onChange={(event) => editor.patch({ password: { maxLength: number(event.target.value) } })}
            />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckboxRow label="Require lowercase letter" checked={settings.password.requireLowercase} onCheckedChange={(requireLowercase) => editor.patch({ password: { requireLowercase } })} />
          <CheckboxRow label="Require uppercase letter" checked={settings.password.requireUppercase} onCheckedChange={(requireUppercase) => editor.patch({ password: { requireUppercase } })} />
          <CheckboxRow label="Require number" checked={settings.password.requireNumbers} onCheckedChange={(requireNumbers) => editor.patch({ password: { requireNumbers } })} />
          <CheckboxRow label="Require special character" checked={settings.password.requireSpecialCharacter} onCheckedChange={(requireSpecialCharacter) => editor.patch({ password: { requireSpecialCharacter } })} />
          <CheckboxRow
            label="Reject pwned passwords"
            description="Check HaveIBeenPwned using k-anonymity. Adds latency to password changes."
            checked={settings.password.rejectPwned}
            onCheckedChange={(rejectPwned) => editor.patch({ password: { rejectPwned } })}
          />
          <CheckboxRow
            label="Sign out other sessions on password change"
            checked={settings.password.signOutOfOtherSessionsOnChange}
            onCheckedChange={(signOutOfOtherSessionsOnChange) => editor.patch({ password: { signOutOfOtherSessionsOnChange } })}
          />
        </div>
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="size-4" /> Passkeys
          </span>
        }
        description="WebAuthn passkeys for phishing-resistant sign-in."
      >
        <SwitchRow
          label="Allow passkeys"
          description="Users can register passkeys from their profile or during sign-up."
          checked={settings.attributes.passkey.enabled}
          onCheckedChange={(enabled) => updateAttribute("passkey", { enabled })}
        />
        <SwitchRow
          label="Use passkeys for sign-in"
          description="Offer passkeys as a first factor on the sign-in form."
          checked={settings.attributes.passkey.usedForFirstFactor}
          disabled={!settings.attributes.passkey.enabled}
          onCheckedChange={(usedForFirstFactor) => updateAttribute("passkey", { usedForFirstFactor })}
        />
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4" /> Multi-factor authentication
          </span>
        }
        description="Second factors required after the first factor succeeds."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <CheckboxRow
            label="Authenticator app (TOTP)"
            description="Six-digit codes from an authenticator app."
            checked={settings.attributes.authenticatorApp.enabled}
            onCheckedChange={(enabled) => updateAttribute("authenticatorApp", { enabled })}
          />
          <CheckboxRow
            label="Backup codes"
            checked={settings.attributes.backupCode.enabled}
            onCheckedChange={(enabled) => updateAttribute("backupCode", { enabled })}
          />
          <CheckboxRow
            label="SMS code"
            description="Requires a verified phone number."
            checked={settings.attributes.phoneNumber.usedForSecondFactor}
            onCheckedChange={(usedForSecondFactor) => updateAttribute("phoneNumber", { usedForSecondFactor })}
          />
          <CheckboxRow
            label="Require MFA for all users"
            description="Every sign-in must complete a second factor."
            checked={settings.mfa.required}
            onCheckedChange={(required) => editor.patch({ mfa: { required } })}
          />
        </div>
        {!hasSecondFactor ? (
          <Alert>
            <AlertTitle>No second factor enabled</AlertTitle>
            <AlertDescription>Requiring MFA without an enabled second factor will lock users out of sign-in.</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Maximum verification attempts" htmlFor="mfa-attempts" description="Failed attempts before the account locks.">
            <Input
              id="mfa-attempts"
              type="number"
              min={1}
              value={settings.mfa.maxAttempts}
              onChange={(event) => editor.patch({ mfa: { maxAttempts: number(event.target.value) } })}
            />
          </Field>
          <Field label="Lockout duration (seconds)" htmlFor="mfa-lockout">
            <Input
              id="mfa-lockout"
              type="number"
              min={0}
              value={settings.mfa.lockoutDurationSeconds}
              onChange={(event) => editor.patch({ mfa: { lockoutDurationSeconds: number(event.target.value) } })}
            />
          </Field>
        </div>
      </SectionCard>

      <SectionCard title="Sign-up" description="Control who can create an account and what they must accept.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Sign-up mode" htmlFor="sign-up-mode" description="Restricted mode requires an invitation; waitlist collects addresses for approval.">
            <Select value={settings.signUp.mode} onValueChange={(mode) => editor.patch({ signUp: { mode } })}>
              <SelectTrigger id="sign-up-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public — anyone can sign up</SelectItem>
                <SelectItem value="restricted">Restricted — invitation only</SelectItem>
                <SelectItem value="waitlist">Waitlist</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <CheckboxRow
          label="Require legal consent"
          description="Users must accept your terms and privacy policy before completing sign-up."
          checked={settings.signUp.legalConsentRequired}
          onCheckedChange={(legalConsentRequired) => editor.patch({ signUp: { legalConsentRequired } })}
        />
        <CheckboxRow
          label="Progressive sign-up"
          description="Let users start with one identifier and add missing requirements later."
          checked={settings.signUp.progressive}
          onCheckedChange={(progressive) => editor.patch({ signUp: { progressive } })}
        />
      </SectionCard>

      <SectionCard title="Personal information" description="Name fields collected during sign-up.">
        <div className="grid gap-3 sm:grid-cols-2">
          {([
            ["firstName", "First name"],
            ["lastName", "Last name"],
          ] as const).map(([key, label]) => (
            <div key={key} className="space-y-2 rounded-lg border p-3">
              <SwitchRow
                label={label}
                checked={settings.attributes[key].enabled}
                onCheckedChange={(enabled) => updateAttribute(key, { enabled })}
              />
              <CheckboxRow
                label="Required"
                checked={settings.attributes[key].required}
                disabled={!settings.attributes[key].enabled}
                onCheckedChange={(required) => updateAttribute(key, { required })}
              />
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Bot & abuse protection" description="Captcha, enumeration protection, and rate limiting for sensitive endpoints.">
        <SwitchRow
          label="Enable bot protection"
          description="Require a captcha challenge on sign-up and password reset."
          checked={settings.security.botProtection}
          onCheckedChange={(botProtection) => editor.patch({ security: { botProtection } })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Captcha provider" htmlFor="captcha-provider">
            <Select
              value={settings.security.captchaProvider}
              onValueChange={(captchaProvider) => editor.patch({ security: { captchaProvider } })}
            >
              <SelectTrigger id="captcha-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="turnstile">Cloudflare Turnstile</SelectItem>
                <SelectItem value="hcaptcha">hCaptcha</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Site key" htmlFor="captcha-site-key">
            <Input
              id="captcha-site-key"
              value={settings.security.captchaSiteKey}
              onChange={(event) => editor.patch({ security: { captchaSiteKey: event.target.value } })}
              placeholder="0x4AAAAAAA…"
            />
          </Field>
          <Field
            label={
              <span className="flex items-center gap-2">
                Secret key
                {captchaSecretConfigured ? <Badge variant="outline">Configured</Badge> : null}
              </span>
            }
            htmlFor="captcha-secret"
            description="Leave blank to keep the stored secret."
            className="sm:col-span-2"
          >
            <Input
              id="captcha-secret"
              type="password"
              autoComplete="new-password"
              value={secretInputValue(settings.security.captchaSecret)}
              onChange={(event) => editor.patch({ security: { captchaSecret: event.target.value } })}
              placeholder={captchaSecretConfigured ? "Stored secret — leave blank to keep" : "Captcha secret"}
            />
          </Field>
        </div>
        <SwitchRow
          label="Enumeration protection"
          description="Return generic responses for unknown identifiers so attackers cannot probe accounts."
          checked={settings.security.enumerationProtection}
          onCheckedChange={(enumerationProtection) => editor.patch({ security: { enumerationProtection } })}
        />
        <SwitchRow
          label="Rate limiting"
          description="Throttle sign-in, sign-up, and verification attempts."
          checked={settings.security.rateLimitEnabled}
          onCheckedChange={(rateLimitEnabled) => editor.patch({ security: { rateLimitEnabled } })}
        />
        <SwitchRow
          label="Testing tokens"
          description="Allow `+clerk_test`-style testing tokens in non-production environments."
          checked={settings.security.testingTokensEnabled}
          onCheckedChange={(testingTokensEnabled) => editor.patch({ security: { testingTokensEnabled } })}
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
