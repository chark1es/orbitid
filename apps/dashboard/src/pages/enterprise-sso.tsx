import { useState } from "react";
import type { EnterpriseConnectionJSON, PaginatedList } from "@orbitid/shared";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@orbitid/ui";
import { Building2, Download, Eye, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, getApiUrl, useApi } from "../lib/api";
import { unwrapList } from "./_config/data";
import {
  errorMessage,
  formatDate,
  formatJson,
  isHttpUrl,
  isValidDomain,
  normalizeDomain,
  parseJsonRecord,
} from "./_config/settings";
import {
  ConfirmDialog,
  CopyButton,
  DetailSheet,
  EmptyState,
  EndpointRow,
  ErrorAlert,
  Field,
  JsonEditor,
  MetaChip,
  PageHeader,
  RuledTable,
  StatusBadge,
  StringListEditor,
  SwitchRow,
  TableSkeleton,
  ValidationSummary,
} from "./_config/ui";

type Protocol = "saml" | "oidc";

interface SsoForm {
  name: string;
  protocol: Protocol;
  domains: string[];
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  attributeMappingText: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  allowSubdomains: boolean;
  allowIdpInitiated: boolean;
  syncUserAttributes: boolean;
  disableAdditionalIdentifications: boolean;
}

const EMPTY_FORM: SsoForm = {
  name: "",
  protocol: "saml",
  domains: [""],
  idpEntityId: "",
  idpSsoUrl: "",
  idpCertificate: "",
  attributeMappingText: formatJson({
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    first_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    last_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  }),
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  allowSubdomains: false,
  allowIdpInitiated: false,
  syncUserAttributes: true,
  disableAdditionalIdentifications: false,
};

function samlSpDetails(connection: EnterpriseConnectionJSON, apiUrl: string) {
  return {
    acsUrl: connection.saml?.acs_url || `${apiUrl}/v1/saml/${connection.id}/acs`,
    entityId: connection.saml?.sp_entity_id || `${apiUrl}/v1/saml/${connection.id}`,
    metadataUrl: connection.saml?.sp_metadata_url || `${apiUrl}/v1/saml/${connection.id}/metadata`,
  };
}

export default function Page() {
  const apiBase = getApiUrl();
  const query = useApi<PaginatedList<EnterpriseConnectionJSON>>(["enterprise_connections"], "/enterprise_connections?limit=100");
  const connections = unwrapList<EnterpriseConnectionJSON>(query.data);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SsoForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<EnterpriseConnectionJSON | null>(null);
  const [selected, setSelected] = useState<EnterpriseConnectionJSON | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [updatingAdvanced, setUpdatingAdvanced] = useState(false);
  const [replacementSecret, setReplacementSecret] = useState("");

  const openWizard = () => {
    setForm(EMPTY_FORM);
    setStep(0);
    setWizardOpen(true);
  };

  const domains = form.domains.map((domain) => normalizeDomain(domain)).filter(Boolean);
  const mapping = parseJsonRecord(form.attributeMappingText);
  const step0Errors: string[] = [];
  if (!form.name.trim()) step0Errors.push("Connection name is required.");
  if (domains.length === 0) step0Errors.push("Add at least one email domain.");
  if (domains.some((domain) => !isValidDomain(domain))) step0Errors.push("Every domain must be a valid email domain.");
  const step1Errors: string[] = [];
  if (form.protocol === "saml") {
    if (!form.idpEntityId.trim()) step1Errors.push("IdP entity ID is required.");
    if (!isHttpUrl(form.idpSsoUrl)) step1Errors.push("IdP SSO URL must be an http(s) URL.");
    if (!form.idpCertificate.trim()) step1Errors.push("IdP signing certificate is required.");
    if (mapping.error) step1Errors.push(`Attribute mapping: ${mapping.error}`);
  } else {
    if (!isHttpUrl(form.discoveryUrl)) step1Errors.push("Discovery URL must be an http(s) URL.");
    if (!form.clientId.trim()) step1Errors.push("OIDC client ID is required.");
    if (!form.clientSecret.trim()) step1Errors.push("OIDC client secret is required.");
  }
  const allErrors = [...step0Errors, ...step1Errors];

  const createConnection = async () => {
    if (allErrors.length > 0) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        protocol: form.protocol,
        domains,
        active: false,
        allow_subdomains: form.allowSubdomains,
        allow_idp_initiated: form.allowIdpInitiated,
        sync_user_attributes: form.syncUserAttributes,
        disable_additional_identifications: form.disableAdditionalIdentifications,
      };
      if (form.protocol === "saml") {
        body.idp_entity_id = form.idpEntityId.trim();
        body.idp_sso_url = form.idpSsoUrl.trim();
        body.idp_certificate = form.idpCertificate.trim();
        body.attribute_mapping = mapping.value ?? {};
      } else {
        body.discovery_url = form.discoveryUrl.trim();
        body.client_id = form.clientId.trim();
        body.client_secret = form.clientSecret;
      }
      await api("POST", "/enterprise_connections", body);
      await query.refetch();
      toast.success("Enterprise connection created", { description: "Activate it after you verify the IdP configuration." });
      setWizardOpen(false);
    } catch (error) {
      toast.error("Could not create connection", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (connection: EnterpriseConnectionJSON) => {
    const active = !connection.active;
    try {
      await api("PATCH", `/enterprise_connections/${connection.id}`, { active });
      await query.refetch();
      setDetail((current) => (current?.id === connection.id ? { ...current, active } : current));
      toast.success(active ? "Connection activated" : "Connection deactivated");
    } catch (error) {
      toast.error("Could not update connection", { description: errorMessage(error) });
    }
  };

  const updateAdvanced = async (patch: Partial<EnterpriseConnectionJSON>) => {
    if (!detail) return;
    setUpdatingAdvanced(true);
    try {
      await api("PATCH", `/enterprise_connections/${detail.id}`, patch);
      await query.refetch();
      setDetail((current) => (current ? { ...current, ...patch } : current));
      toast.success("Connection updated");
    } catch (error) {
      toast.error("Could not update connection", { description: errorMessage(error) });
    } finally {
      setUpdatingAdvanced(false);
    }
  };

  /** The OIDC client secret is write-only: it is sent alone, never echoed back with the rest of the connection. */
  const replaceOidcSecret = async () => {
    if (!detail || !replacementSecret.trim()) return;
    setUpdatingAdvanced(true);
    try {
      await api("PATCH", `/enterprise_connections/${detail.id}`, { client_secret: replacementSecret });
      setReplacementSecret("");
      toast.success("Client secret replaced", { description: "The previous secret stops working immediately." });
    } catch (error) {
      toast.error("Could not replace client secret", { description: errorMessage(error) });
    } finally {
      setUpdatingAdvanced(false);
    }
  };

  const deleteConnection = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await api("DELETE", `/enterprise_connections/${selected.id}`);
      await query.refetch();
      if (detail?.id === selected.id) setDetail(null);
      toast.success("Enterprise connection deleted");
      setSelected(null);
    } catch (error) {
      toast.error("Could not delete connection", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  const downloadMetadata = async (connection: EnterpriseConnectionJSON) => {
    const { metadataUrl } = samlSpDetails(connection, apiBase);
    try {
      const response = await fetch(metadataUrl);
      if (!response.ok) throw new Error(`Metadata request failed (${response.status})`);
      const text = await response.text();
      const blob = new Blob([text], { type: "application/xml" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${connection.name.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}-metadata.xml`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success("Metadata downloaded");
    } catch (error) {
      toast.error("Could not download metadata", { description: errorMessage(error) });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Enterprise SSO"
        description="Domain-routed SAML 2.0 and OpenID Connect connections. Users with a matching email domain are sent to the identity provider."
        badge={<MetaChip>{connections.length} {connections.length === 1 ? "connection" : "connections"}</MetaChip>}
        actions={
          <Button size="sm" onClick={openWizard}>
            <Plus className="size-4" aria-hidden /> Connect SSO
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Connections</h2>
          <p className="text-xs text-muted-foreground">Only active connections take part in domain routing.</p>
        </div>
        {query.isLoading ? (
          <TableSkeleton />
        ) : connections.length === 0 ? (
          <EmptyState
            title="No enterprise connections"
            description="Connect any SAML 2.0 or OpenID Connect identity provider your organization already uses."
            icon={<Building2 className="size-5" />}
            action={
              <Button size="sm" onClick={openWizard}>
                <Plus className="size-4" aria-hidden /> Connect SSO
              </Button>
            }
          />
        ) : (
          <RuledTable>
            <TableHeader>
              <TableRow>
                <TableHead>Connection</TableHead>
                <TableHead>Protocol</TableHead>
                <TableHead>Domains</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-24 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connections.map((connection) => (
                <TableRow key={connection.id}>
                  <TableCell className="text-sm font-medium">{connection.name}</TableCell>
                  <TableCell className="font-data text-xs uppercase">{connection.protocol}</TableCell>
                  <TableCell>
                    <span className="block max-w-[22rem] truncate text-xs text-muted-foreground">{connection.domains.join(", ")}</span>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Switch checked={connection.active} onCheckedChange={() => void toggleActive(connection)} aria-label="Connection active" />
                      <StatusBadge status={connection.active ? "active" : "disabled"} />
                    </div>
                  </TableCell>
                  <TableCell className="font-data text-xs text-muted-foreground">{formatDate(connection.created_at)}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => setDetail(connection)} title="Details">
                        <Eye className="size-4" aria-hidden />
                        <span className="sr-only">Details for {connection.name}</span>
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(connection)} title="Delete">
                        <Trash2 className="size-4" aria-hidden />
                        <span className="sr-only">Delete {connection.name}</span>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </RuledTable>
        )}
      </section>

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

      <DetailSheet
        open={detail !== null}
        onOpenChange={(open) => !open && setDetail(null)}
        size="lg"
        title={detail?.name ?? "Connection"}
        description={detail ? `${detail.protocol.toUpperCase()} connection` : undefined}
        footer={
          <>
            <Button variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
            {detail ? (
              <Button variant="destructive" onClick={() => setSelected(detail)}>
                <Trash2 className="size-4" aria-hidden /> Delete
              </Button>
            ) : null}
          </>
        }
      >
        {detail ? (
          <div className="space-y-5">
            <SwitchRow
              label="Active"
              description="Route sign-ins for these domains to this identity provider."
              checked={detail.active}
              onCheckedChange={() => void toggleActive(detail)}
            />
            <div className="flex flex-wrap gap-1">
              {detail.domains.map((domain) => (
                <span key={domain} className="border border-border px-1.5 py-0.5 font-data text-xs text-muted-foreground">
                  {domain}
                </span>
              ))}
            </div>
            {detail.protocol === "saml" ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Service provider details</p>
                <p className="text-xs leading-relaxed text-muted-foreground">Use these values in the SAML application at your IdP.</p>
                <EndpointRow label="ACS URL" url={samlSpDetails(detail, apiBase).acsUrl} />
                <EndpointRow label="SP entity ID" url={samlSpDetails(detail, apiBase).entityId} />
                <EndpointRow label="Metadata URL" url={samlSpDetails(detail, apiBase).metadataUrl} />
                <Button variant="outline" size="sm" onClick={() => void downloadMetadata(detail)}>
                  <Download className="size-4" aria-hidden /> Download metadata XML
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">OpenID Connect</p>
                <EndpointRow label="Discovery URL" url={detail.oidc?.discovery_url ?? "Not set"} />
                {detail.oidc?.client_id ? (
                  <div className="flex items-center justify-between gap-3 border-b border-border py-2">
                    <div className="min-w-0">
                      <p className="text-[0.8125rem] font-medium">Client ID</p>
                      <code className="block truncate font-data text-xs text-muted-foreground">{detail.oidc.client_id}</code>
                    </div>
                    <CopyButton value={detail.oidc.client_id} size="icon-sm" variant="outline" />
                  </div>
                ) : null}
                <Field
                  label="Replace client secret"
                  htmlFor="sso-oidc-replace-secret"
                  description="The stored secret is never returned by the API. Leave blank to keep it; type a new value to replace it."
                >
                  <Input
                    id="sso-oidc-replace-secret"
                    type="password"
                    autoComplete="new-password"
                    value={replacementSecret}
                    onChange={(event) => setReplacementSecret(event.target.value)}
                    placeholder="Leave blank to keep the stored secret"
                  />
                </Field>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!replacementSecret.trim() || updatingAdvanced}
                  onClick={() => void replaceOidcSecret()}
                >
                  Replace secret
                </Button>
              </div>
            )}
            <div>
              <p className="pb-1 text-sm font-medium">Advanced</p>
              <SwitchRow
                label="Allow subdomains"
                checked={detail.allow_subdomains}
                disabled={updatingAdvanced}
                onCheckedChange={(allow_subdomains) => void updateAdvanced({ allow_subdomains })}
              />
              <SwitchRow
                label="Allow IdP-initiated sign-in"
                checked={detail.allow_idp_initiated}
                disabled={updatingAdvanced}
                onCheckedChange={(allow_idp_initiated) => void updateAdvanced({ allow_idp_initiated })}
              />
              <SwitchRow
                label="Sync user attributes"
                checked={detail.sync_user_attributes}
                disabled={updatingAdvanced}
                onCheckedChange={(sync_user_attributes) => void updateAdvanced({ sync_user_attributes })}
              />
              <SwitchRow
                label="Disable additional identifications"
                description="Prevent users from adding email addresses outside this IdP's domains."
                checked={detail.disable_additional_identifications}
                disabled={updatingAdvanced}
                onCheckedChange={(disable_additional_identifications) => void updateAdvanced({ disable_additional_identifications })}
              />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Sign-ins with an email at {detail.domains.join(", ")} return the enterprise SSO factor. Deactivating the connection falls back
              to the other sign-in methods.
            </p>
          </div>
        ) : null}
      </DetailSheet>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="Delete enterprise connection?"
        description={
          <span>
            Users at <strong>{selected?.domains.join(", ")}</strong> are no longer routed to this identity provider.
          </span>
        }
        confirmLabel="Delete connection"
        destructive
        loading={deleting}
        onConfirm={() => void deleteConnection()}
      />
    </div>
  );
}
