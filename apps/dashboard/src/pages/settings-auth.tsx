import type { AttributeConfig } from "@orbitid/shared";
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import {
  CheckboxRow,
  ErrorAlert,
  Field,
  LoadingPage,
  MetaChip,
  PageHeader,
  SaveBar,
  SecretInput,
  SettingsSection,
  SwitchRow,
} from "./_config/ui";
import {
  attributeProblems,
  secretInputValue,
  secretIsConfigured,
  humanDuration,
  type AttributeKey,
} from "./_config/settings";
import { useSettingsEditor } from "./_config/use-settings";
import { AttributeBlock } from "./_settings-auth/attribute-block";

export default function Page() {
  const editor = useSettingsEditor();
  const settings = editor.settings;

  if (editor.isLoading) return <LoadingPage rows={5} />;
  if (!settings) {
    return (
      <div className="space-y-6">
        <PageHeader title="User & authentication" description="Identifiers, password policy, second factors, and abuse protection." />
        <ErrorAlert error={editor.error ?? "Instance settings did not load."} onRetry={editor.refetch} />
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

  const problems = attributeProblems(settings);
  for (const problem of problems) errors.push(problem.message);
  const problemsFor = (key: AttributeKey) =>
    problems.filter((problem) => problem.attribute === key).map((problem) => problem.message);
  const SHOWN_IN_BLOCK: (AttributeKey | null)[] = ["emailAddress", "phoneNumber", "username"];
  const otherProblems = problems.filter((problem) => !SHOWN_IN_BLOCK.includes(problem.attribute));

  const updateAttribute = (key: AttributeKey, patch: Partial<AttributeConfig>) => {
    editor.patch({ attributes: { [key]: patch } });
  };
  const number = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const captchaSecretConfigured = secretIsConfigured(settings.security.captchaSecret);
  const emailSecondFactor = settings.attributes.emailAddress.usedForSecondFactor;
  const hasSecondFactor =
    settings.attributes.authenticatorApp.enabled || settings.attributes.backupCode.enabled || settings.attributes.phoneNumber.usedForSecondFactor;
  if (settings.mfa.required && !hasSecondFactor && !emailSecondFactor) errors.push("Enable at least one second factor before requiring MFA.");
  if (emailSecondFactor && !settings.attributes.emailAddress.enabled) errors.push("Enable the email address identifier before using it as a second factor.");
  if (emailSecondFactor && settings.attributes.emailAddress.verifications.length === 0)
    errors.push("Email code as a second factor needs a verification method on the email address.");

  return (
    <div className="space-y-6">
      <PageHeader
        title="User & authentication"
        description="Choose how users identify themselves, how passwords are enforced, and which second factors they can use."
        badge={<MetaChip>Instance settings</MetaChip>}
      />

      {editor.error ? <ErrorAlert error={editor.error} onRetry={editor.refetch} /> : null}

      <SettingsSection
        title="Identifiers"
        description="Each identifier can be enabled, required, and accepted on the sign-in form. Verification methods apply to sign-up and sign-in."
      >
        {otherProblems.length > 0 ? (
          <ul role="alert" className="space-y-1 text-[0.8125rem] leading-relaxed text-signal">
            {otherProblems.map((problem) => (
              <li key={problem.message}>{problem.message}</li>
            ))}
          </ul>
        ) : null}
        <AttributeBlock
          title="Email address"
          description="The primary identifier for most applications."
          config={settings.attributes.emailAddress}
          onChange={(patch) => updateAttribute("emailAddress", patch)}
          problems={problemsFor("emailAddress")}
          verificationOptions={[
            { value: "email_code", label: "Email code" },
            { value: "email_link", label: "Email link" },
          ]}
        />
        <AttributeBlock
          title="Phone number"
          description="SMS-based sign-in and verification."
          config={settings.attributes.phoneNumber}
          onChange={(patch) => updateAttribute("phoneNumber", patch)}
          problems={problemsFor("phoneNumber")}
          verificationOptions={[{ value: "phone_code", label: "SMS code" }]}
        />
        <AttributeBlock
          title="Username"
          description="A unique handle users can sign in with."
          config={settings.attributes.username}
          onChange={(patch) => updateAttribute("username", patch)}
          problems={problemsFor("username")}
          showVerification={false}
          showVerifyAtSignUp={false}
        />
        {settings.attributes.username.enabled ? (
          <div className="grid gap-4 sm:grid-cols-2">
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
      </SettingsSection>

      <SettingsSection
        title="Password"
        description="Password sign-in and complexity requirements. Password length counts characters, not bytes."
        actions={<MetaChip>{settings.attributes.password.enabled ? "Enabled" : "Disabled"}</MetaChip>}
      >
        <SwitchRow
          label="Allow password sign-in"
          description="Turn off to require passwordless or social sign-in."
          checked={settings.attributes.password.enabled}
          onCheckedChange={(enabled) => updateAttribute("password", enabled ? { enabled } : { enabled, required: false })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
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
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <CheckboxRow label="Require a lowercase letter" checked={settings.password.requireLowercase} onCheckedChange={(requireLowercase) => editor.patch({ password: { requireLowercase } })} />
          <CheckboxRow label="Require an uppercase letter" checked={settings.password.requireUppercase} onCheckedChange={(requireUppercase) => editor.patch({ password: { requireUppercase } })} />
          <CheckboxRow label="Require a number" checked={settings.password.requireNumbers} onCheckedChange={(requireNumbers) => editor.patch({ password: { requireNumbers } })} />
          <CheckboxRow label="Require a special character" checked={settings.password.requireSpecialCharacter} onCheckedChange={(requireSpecialCharacter) => editor.patch({ password: { requireSpecialCharacter } })} />
          <CheckboxRow
            label="Reject breached passwords"
            description="Check HaveIBeenPwned with k-anonymity. Adds latency to password changes."
            checked={settings.password.rejectPwned}
            onCheckedChange={(rejectPwned) => editor.patch({ password: { rejectPwned } })}
          />
          <CheckboxRow
            label="Sign out other sessions on password change"
            checked={settings.password.signOutOfOtherSessionsOnChange}
            onCheckedChange={(signOutOfOtherSessionsOnChange) => editor.patch({ password: { signOutOfOtherSessionsOnChange } })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Passkeys" description="WebAuthn passkeys for phishing-resistant sign-in.">
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
      </SettingsSection>

      <SettingsSection title="Multi-factor authentication" description="Second factors required after the first factor succeeds.">
        <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
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
            label="Email one-time code"
            description="Send a code to the user's verified email address as the second step."
            checked={settings.attributes.emailAddress.usedForSecondFactor}
            disabled={!settings.attributes.emailAddress.enabled}
            onCheckedChange={(usedForSecondFactor) => updateAttribute("emailAddress", { usedForSecondFactor })}
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
          <p className="text-xs leading-relaxed text-muted-foreground">
            No second factor is enabled. Enabling “Require MFA for all users” without one locks every user out of sign-in.
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
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
      </SettingsSection>

      <SettingsSection title="Sign-up" description="Who can create an account and what they must accept.">
        <Field
          label="Sign-up mode"
          htmlFor="sign-up-mode"
          description="Restricted mode requires an invitation. Waitlist collects addresses for approval."
          className="max-w-md"
        >
          <Select value={settings.signUp.mode} onValueChange={(mode) => editor.patch({ signUp: { mode } })}>
            <SelectTrigger id="sign-up-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public: anyone can sign up</SelectItem>
              <SelectItem value="restricted">Restricted: invitation only</SelectItem>
              <SelectItem value="waitlist">Waitlist</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <CheckboxRow
          label="Require legal consent"
          description="Users accept your terms and privacy policy before sign-up completes."
          checked={settings.signUp.legalConsentRequired}
          onCheckedChange={(legalConsentRequired) => editor.patch({ signUp: { legalConsentRequired } })}
        />
        <CheckboxRow
          label="Progressive sign-up"
          description="Let users start with one identifier and add the missing requirements later."
          checked={settings.signUp.progressive}
          onCheckedChange={(progressive) => editor.patch({ signUp: { progressive } })}
        />
      </SettingsSection>

      <SettingsSection
        title="Guest accounts"
        description="Let a visitor start using the app before they sign up. A guest has no identifier until they add one."
      >
        <SwitchRow
          label="Allow anonymous sign-ups"
          description="The anonymous sign-up strategy is accepted and creates a user with no email address or password."
          checked={settings.anonymous.enabled}
          onCheckedChange={(enabled) => editor.patch({ anonymous: { enabled } })}
        />
        <Field
          label="Delete inactive guests after (seconds)"
          htmlFor="anonymous-retention"
          description={
            settings.anonymous.retentionSeconds > 0
              ? `A guest with no activity for ${humanDuration(settings.anonymous.retentionSeconds)} is deleted. 0 keeps them forever.`
              : "0 keeps guests until they are deleted by hand."
          }
          className="max-w-md"
        >
          <Input
            id="anonymous-retention"
            type="number"
            min={0}
            value={settings.anonymous.retentionSeconds}
            disabled={!settings.anonymous.enabled}
            onChange={(event) => editor.patch({ anonymous: { retentionSeconds: number(event.target.value) } })}
          />
        </Field>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Guests count against your user totals and can reach anything a signed-in user can, so keep the list short in
          the Users page.
        </p>
      </SettingsSection>

      <SettingsSection title="Personal information" description="Name fields collected during sign-up.">
        <div className="grid gap-6 sm:grid-cols-2">
          {([
            ["firstName", "First name"],
            ["lastName", "Last name"],
          ] as const).map(([key, label]) => (
            <div key={key} className="space-y-2 border-b border-border pb-3 sm:border-b-0 sm:pb-0">
              <SwitchRow
                label={label}
                checked={settings.attributes[key].enabled}
                onCheckedChange={(enabled) => updateAttribute(key, enabled ? { enabled } : { enabled, required: false })}
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
      </SettingsSection>

      <SettingsSection title="Bot and abuse protection" description="Captcha, account enumeration protection, and rate limits on sensitive endpoints.">
        <SwitchRow
          label="Enable bot protection"
          description="Require a captcha challenge on sign-up and password reset."
          checked={settings.security.botProtection}
          onCheckedChange={(botProtection) => editor.patch({ security: { botProtection } })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
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
              className="font-data"
            />
          </Field>
          <SecretInput
            id="captcha-secret"
            label="Secret key"
            configured={captchaSecretConfigured}
            value={secretInputValue(settings.security.captchaSecret)}
            onChange={(captchaSecret) => editor.patch({ security: { captchaSecret } })}
            description={captchaSecretConfigured ? "A secret is stored. Leave blank to keep it." : "From the captcha provider's dashboard."}
            placeholder={captchaSecretConfigured ? "Stored secret, leave blank to keep" : "Captcha secret"}
            className="sm:col-span-2"
          />
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
          description="Allow fixed test codes in non-production environments."
          checked={settings.security.testingTokensEnabled}
          onCheckedChange={(testingTokensEnabled) => editor.patch({ security: { testingTokensEnabled } })}
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
