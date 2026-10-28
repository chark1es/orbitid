import { useState } from "react";
import type { EnterpriseConnectionJSON, PaginatedList } from "@orbitid/shared";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Switch,
  Table,
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
  EmptyState,
  EndpointRow,
  ErrorAlert,
  Field,
  JsonEditor,
  PageHeader,
  SectionCard,
  StringListEditor,
  SwitchRow,
  TableSkeleton,
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<SsoForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<EnterpriseConnectionJSON | null>(null);
  const [selected, setSelected] = useState<EnterpriseConnectionJSON | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [updatingAdvanced, setUpdatingAdvanced] = useState(false);

  const openWizard = () => {
    setForm(EMPTY_FORM);
    setStep(0);
    setDialogOpen(true);
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
      toast.success("Enterprise connection created", { description: "Activate it after verifying the IdP configuration." });
      setDialogOpen(false);
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
        actions={
          <Button size="sm" onClick={openWizard}>
            <Plus className="size-4" /> Connect SSO
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      <SectionCard title="Connections" description="Only active connections participate in domain-based sign-in routing.">
        {query.isLoading ? (
          <TableSkeleton />
        ) : connections.length === 0 ? (
          <EmptyState
            title="No enterprise connections"
            description="Connect Okta, Entra ID, Google Workspace, or any SAML/OIDC identity provider."
            icon={<Building2 className="size-6" />}
            action={
              <Button size="sm" onClick={openWizard}>
                <Plus className="size-4" /> Connect SSO
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Connection</TableHead>
                  <TableHead>Protocol</TableHead>
                  <TableHead>Domains</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {connections.map((connection) => (
                  <TableRow key={connection.id}>
                    <TableCell className="font-medium">{connection.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="uppercase">
                        {connection.protocol}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {connection.domains.map((domain) => (
                          <Badge key={domain} variant="secondary">
                            {domain}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch checked={connection.active} onCheckedChange={() => void toggleActive(connection)} aria-label="Connection active" />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(connection.created_at)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => setDetail(connection)} title="Details">
                          <Eye className="size-4" />
                          <span className="sr-only">Details</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(connection)} title="Delete">
                          <Trash2 className="size-4" />
                          <span className="sr-only">Delete</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Connect enterprise SSO</DialogTitle>
            <DialogDescription>Step {step + 1} of 3 — {step === 0 ? "protocol and domains" : step === 1 ? "identity provider" : "review"}</DialogDescription>
          </DialogHeader>
          <div className="mb-2 flex gap-1">
            {[0, 1, 2].map((index) => (
              <div key={index} className={`h-1 flex-1 rounded-full ${index <= step ? "bg-primary" : "bg-muted"}`} />
            ))}
          </div>
          {step === 0 ? (
            <div className="space-y-3">
              <Field label="Connection name" htmlFor="sso-name" required>
                <Input id="sso-name" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Okta production" />
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
                  onChange={(domains) => setForm((current) => ({ ...current, domains }))}
                  placeholder="example.com"
                  addLabel="Add domain"
                  inputType="text"
                />
              </Field>
            </div>
          ) : step === 1 ? (
            <div className="space-y-3">
              {form.protocol === "saml" ? (
                <>
                  <Field label="IdP entity ID" htmlFor="sso-idp-entity" required>
                    <Input
                      id="sso-idp-entity"
                      value={form.idpEntityId}
                      onChange={(event) => setForm((current) => ({ ...current, idpEntityId: event.target.value }))}
                      placeholder="http://www.okta.com/exk…"
                    />
                  </Field>
                  <Field label="IdP SSO URL" htmlFor="sso-idp-sso" required>
                    <Input
                      id="sso-idp-sso"
                      value={form.idpSsoUrl}
                      onChange={(event) => setForm((current) => ({ ...current, idpSsoUrl: event.target.value }))}
                      placeholder="https://example.okta.com/app/…/sso/saml"
                    />
                  </Field>
                  <Field label="IdP signing certificate" htmlFor="sso-idp-cert" required description="PEM or Base64 X.509 certificate.">
                    <Textarea
                      id="sso-idp-cert"
                      rows={5}
                      value={form.idpCertificate}
                      onChange={(event) => setForm((current) => ({ ...current, idpCertificate: event.target.value }))}
                      className="font-mono text-xs"
                      placeholder="-----BEGIN CERTIFICATE-----"
                    />
                  </Field>
                  <Field label="Attribute mapping (JSON)" error={mapping.error}>
                    <JsonEditor
                      value={form.attributeMappingText}
                      onChange={(attributeMappingText) => setForm((current) => ({ ...current, attributeMappingText }))}
                      rows={6}
                      error={mapping.error}
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
                    />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Client ID" htmlFor="sso-oidc-client-id" required>
                      <Input id="sso-oidc-client-id" value={form.clientId} onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))} />
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
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Name</p>
                  <p className="text-sm font-medium">{form.name || "—"}</p>
                </div>
                <div className="rounded-lg border px-3 py-2">
                  <p className="text-xs text-muted-foreground">Protocol</p>
                  <p className="text-sm font-medium uppercase">{form.protocol}</p>
                </div>
                <div className="rounded-lg border px-3 py-2 sm:col-span-2">
                  <p className="text-xs text-muted-foreground">Domains</p>
                  <p className="text-sm font-medium">{domains.join(", ") || "—"}</p>
                </div>
              </div>
              {form.protocol === "saml" ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">Service provider details</p>
                  <p className="text-xs text-muted-foreground">The connection is created inactive. Copy these values into your IdP.</p>
                  <EndpointRow label="ACS URL" url={`${apiBase}/v1/saml/pending/acs`} />
                  <EndpointRow label="SP entity ID" url={`${apiBase}/v1/saml/pending`} />
                  <EndpointRow label="Metadata URL" url={`${apiBase}/v1/saml/pending/metadata`} />
                  <p className="text-xs text-muted-foreground">The final connection ID is assigned after creation; open the connection to copy the real values.</p>
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
                description="Update first name, last name, and image from IDP claims on each sign-in."
                checked={form.syncUserAttributes}
                onCheckedChange={(syncUserAttributes) => setForm((current) => ({ ...current, syncUserAttributes }))}
              />
            </div>
          )}
          {allErrors.length > 0 ? (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
              {allErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
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
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              {detail?.name}
              {detail ? <Badge variant={detail.active ? "default" : "secondary"}>{detail.active ? "Active" : "Inactive"}</Badge> : null}
            </SheetTitle>
            <SheetDescription className="uppercase">{detail?.protocol} connection</SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="space-y-4 px-4 pb-4">
              <SwitchRow
                label="Active"
                description="Route sign-ins for these domains to this identity provider."
                checked={detail.active}
                onCheckedChange={() => void toggleActive(detail)}
              />
              <div className="flex flex-wrap gap-1">
                {detail.domains.map((domain) => (
                  <Badge key={domain} variant="secondary">
                    {domain}
                  </Badge>
                ))}
              </div>
              {detail.protocol === "saml" ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">Service provider details</p>
                  <p className="text-xs text-muted-foreground">Use these values in your IdP's SAML application.</p>
                  <EndpointRow label="ACS URL" url={samlSpDetails(detail, apiBase).acsUrl} />
                  <EndpointRow label="SP entity ID" url={samlSpDetails(detail, apiBase).entityId} />
                  <EndpointRow label="Metadata URL" url={samlSpDetails(detail, apiBase).metadataUrl} />
                  <Button variant="outline" size="sm" onClick={() => void downloadMetadata(detail)}>
                    <Download className="size-4" /> Download metadata XML
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm font-medium">OpenID Connect</p>
                  <EndpointRow label="Discovery URL" url={detail.oidc?.discovery_url ?? "—"} />
                  {detail.oidc?.client_id ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">Client ID</p>
                        <code className="block truncate text-xs text-muted-foreground">{detail.oidc.client_id}</code>
                      </div>
                      <CopyButton value={detail.oidc.client_id} size="icon-sm" variant="outline" />
                    </div>
                  ) : null}
                </div>
              )}
              <div className="space-y-2">
                <p className="text-sm font-medium">Advanced</p>
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
              <Alert>
                <AlertTitle>Domain routing</AlertTitle>
                <AlertDescription>
                  Sign-ins with an email at {detail.domains.join(", ")} return the enterprise SSO factor. Deactivating this
                  connection falls back to your other sign-in methods.
                </AlertDescription>
              </Alert>
            </div>
          ) : null}
          <SheetFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>
              Close
            </Button>
            {detail ? (
              <Button variant="destructive" onClick={() => setSelected(detail)}>
                <Trash2 className="size-4" /> Delete
              </Button>
            ) : null}
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="Delete enterprise connection?"
        description={
          <span>
            Users at <strong>{selected?.domains.join(", ")}</strong> will no longer be routed to this identity provider.
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
