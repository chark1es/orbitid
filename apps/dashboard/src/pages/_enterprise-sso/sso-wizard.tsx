import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@orbitid/ui";
import {
  DetailSheet,
  EndpointRow,
  Field,
  JsonEditor,
  StringListEditor,
  SwitchRow,
  ValidationSummary,
} from "../_config/ui";
import type { EnterpriseSsoController } from "./use-enterprise-sso";
import { type Protocol } from "./model";

export function SsoWizard({ ctl }: { ctl: EnterpriseSsoController }) {
  const {
    wizardOpen,
    setWizardOpen,
    step,
    setStep,
    form,
    setForm,
    saving,
    apiBase,
    domains,
    mapping,
    step0Errors,
    step1Errors,
    allErrors,
    createConnection,
  } = ctl;

  return (
    <DetailSheet
      open={wizardOpen}
      onOpenChange={setWizardOpen}
      size="lg"
      title="Connect enterprise SSO"
      description={`Step ${step + 1} of 3: ${step === 0 ? "name and domains" : step === 1 ? "identity provider" : "review"}`}
      footer={
        <>
          <Button variant="outline" onClick={() => setWizardOpen(false)} disabled={saving}>
            Cancel
          </Button>
          {step > 0 ? (
            <Button variant="outline" onClick={() => setStep((current) => current - 1)} disabled={saving}>
              Back
            </Button>
          ) : null}
          {step < 2 ? (
            <Button
              onClick={() => setStep((current) => current + 1)}
              disabled={step === 0 ? step0Errors.length > 0 : step1Errors.length > 0}
            >
              Next
            </Button>
          ) : (
            <Button onClick={() => void createConnection()} disabled={saving || allErrors.length > 0}>
              {saving ? "Creating…" : "Create connection"}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4 flex gap-1" aria-hidden>
        {[0, 1, 2].map((index) => (
          <span key={index} className={`h-0.5 flex-1 ${index <= step ? "bg-foreground" : "bg-border"}`} />
        ))}
      </div>
      {step === 0 ? (
        <div className="space-y-4">
          <Field label="Connection name" htmlFor="sso-name" required>
            <Input id="sso-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Corporate identity provider" />
          </Field>
          <Field label="Protocol" htmlFor="sso-protocol">
            <Select value={form.protocol} onValueChange={(protocol) => setForm((current) => ({ ...current, protocol: protocol as Protocol }))}>
              <SelectTrigger id="sso-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="saml">SAML 2.0</SelectItem>
                <SelectItem value="oidc">OpenID Connect</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Email domains" required description="Sign-ins with these email domains route to this connection.">
            <StringListEditor
              values={form.domains}
              onChange={(nextDomains) => setForm((current) => ({ ...current, domains: nextDomains }))}
              placeholder="example.com"
              addLabel="Add domain"
              inputType="text"
            />
          </Field>
          <ValidationSummary errors={step0Errors} title="Fix these to continue" />
        </div>
      ) : step === 1 ? (
        <div className="space-y-4">
          {form.protocol === "saml" ? (
            <>
              <Field label="IdP entity ID" htmlFor="sso-idp-entity" required>
                <Input
                  id="sso-idp-entity"
                  value={form.idpEntityId}
                  onChange={(event) => setForm((current) => ({ ...current, idpEntityId: event.target.value }))}
                  placeholder="https://idp.example.com/entity"
                  className="font-data text-xs"
                />
              </Field>
              <Field label="IdP SSO URL" htmlFor="sso-idp-sso" required>
                <Input
                  id="sso-idp-sso"
                  value={form.idpSsoUrl}
                  onChange={(event) => setForm((current) => ({ ...current, idpSsoUrl: event.target.value }))}
                  placeholder="https://idp.example.com/app/sso/saml"
                  className="font-data text-xs"
                />
              </Field>
              <Field label="IdP signing certificate" htmlFor="sso-idp-cert" required description="PEM or Base64 X.509 certificate.">
                <Textarea
                  id="sso-idp-cert"
                  rows={5}
                  value={form.idpCertificate}
                  onChange={(event) => setForm((current) => ({ ...current, idpCertificate: event.target.value }))}
                  className="font-data text-xs"
                  placeholder="-----BEGIN CERTIFICATE-----"
                />
              </Field>
              <Field label="Attribute mapping (JSON)" error={mapping.error}>
                <JsonEditor
                  value={form.attributeMappingText}
                  onChange={(attributeMappingText) => setForm((current) => ({ ...current, attributeMappingText }))}
                  rows={6}
                  error={mapping.error}
                  aria-label="Attribute mapping"
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Discovery URL" htmlFor="sso-oidc-discovery" required>
                <Input
                  id="sso-oidc-discovery"
                  value={form.discoveryUrl}
                  onChange={(event) => setForm((current) => ({ ...current, discoveryUrl: event.target.value }))}
                  placeholder="https://auth.example.com/.well-known/openid-configuration"
                  className="font-data text-xs"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Client ID" htmlFor="sso-oidc-client-id" required>
                  <Input
                    id="sso-oidc-client-id"
                    value={form.clientId}
                    onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))}
                    className="font-data text-xs"
                  />
                </Field>
                <Field label="Client secret" htmlFor="sso-oidc-client-secret" required>
                  <Input
                    id="sso-oidc-client-secret"
                    type="password"
                    autoComplete="new-password"
                    value={form.clientSecret}
                    onChange={(event) => setForm((current) => ({ ...current, clientSecret: event.target.value }))}
                  />
                </Field>
              </div>
            </>
          )}
          <ValidationSummary errors={step1Errors} title="Fix these to continue" />
        </div>
      ) : (
        <div className="space-y-4">
          <dl className="divide-y divide-border border-y border-border">
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-xs text-muted-foreground">Name</dt>
              <dd className="text-sm font-medium">{form.name || "Not set"}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-xs text-muted-foreground">Protocol</dt>
              <dd className="font-data text-xs uppercase">{form.protocol}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 py-2">
              <dt className="text-xs text-muted-foreground">Domains</dt>
              <dd className="text-sm font-medium">{domains.join(", ") || "Not set"}</dd>
            </div>
          </dl>
          {form.protocol === "saml" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium">Service provider details</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                The connection is created inactive. Your IdP needs these values, but the connection ID is assigned on creation. Open the
                connection afterward to copy the final values.
              </p>
              <EndpointRow label="ACS URL" url={`${apiBase}/v1/saml/pending/acs`} />
              <EndpointRow label="SP entity ID" url={`${apiBase}/v1/saml/pending`} />
              <EndpointRow label="Metadata URL" url={`${apiBase}/v1/saml/pending/metadata`} />
            </div>
          ) : null}
          <SwitchRow
            label="Allow subdomains"
            description="Match users in subdomains of the configured domains."
            checked={form.allowSubdomains}
            onCheckedChange={(allowSubdomains) => setForm((current) => ({ ...current, allowSubdomains }))}
          />
          <SwitchRow
            label="Allow IdP-initiated sign-in"
            description="Accept unsolicited SAML responses from the identity provider."
            checked={form.allowIdpInitiated}
            onCheckedChange={(allowIdpInitiated) => setForm((current) => ({ ...current, allowIdpInitiated }))}
          />
          <SwitchRow
            label="Sync user attributes"
            description="Update first name, last name, and image from IdP claims on each sign-in."
            checked={form.syncUserAttributes}
            onCheckedChange={(syncUserAttributes) => setForm((current) => ({ ...current, syncUserAttributes }))}
          />
          <ValidationSummary errors={allErrors} title="Fix these before creating the connection" />
        </div>
      )}
    </DetailSheet>
  );
}
