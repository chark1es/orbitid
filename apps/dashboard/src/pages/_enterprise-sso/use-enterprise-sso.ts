import { useState } from "react";
import type { EnterpriseConnectionJSON, PaginatedList } from "@orbitid/shared";
import { toast } from "sonner";
import { api, apiAllPages, getApiUrl, useApi } from "../../lib/api";
import { unwrapList } from "../_config/data";
import {
  errorMessage,
  isHttpUrl,
  isValidDomain,
  normalizeDomain,
  parseJsonRecord,
} from "../_config/settings";
import { type SsoForm, EMPTY_FORM, samlSpDetails } from "./model";

export function useEnterpriseSso() {
  const apiBase = getApiUrl();
  const query = useApi<PaginatedList<EnterpriseConnectionJSON>>(["enterprise_connections"], "/enterprise_connections", {
    queryFn: ({ signal }) => apiAllPages<EnterpriseConnectionJSON>("/enterprise_connections", { signal }),
  });
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
  const hasMetadata = Boolean(form.idpMetadataUrl.trim() || form.idpMetadataXml.trim());
  if (form.protocol === "saml") {
    if (form.idpMetadataUrl.trim() && !isHttpUrl(form.idpMetadataUrl)) step1Errors.push("Metadata URL must be an http(s) URL.");
    if (!hasMetadata) {
      if (!form.idpEntityId.trim()) step1Errors.push("IdP entity ID is required.");
      if (!isHttpUrl(form.idpSsoUrl)) step1Errors.push("IdP SSO URL must be an http(s) URL.");
      if (!form.idpCertificate.trim()) step1Errors.push("IdP signing certificate is required.");
    }
    if (form.idpSsoUrl.trim() && !isHttpUrl(form.idpSsoUrl)) step1Errors.push("IdP SSO URL must be an http(s) URL.");
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
        if (form.idpMetadataUrl.trim()) body.idp_metadata_url = form.idpMetadataUrl.trim();
        if (form.idpMetadataXml.trim()) body.idp_metadata_xml = form.idpMetadataXml.trim();
        if (form.idpEntityId.trim()) body.idp_entity_id = form.idpEntityId.trim();
        if (form.idpSsoUrl.trim()) body.idp_sso_url = form.idpSsoUrl.trim();
        if (form.idpCertificate.trim()) body.idp_certificate = form.idpCertificate.trim();
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

  return {
    wizardOpen,
    setWizardOpen,
    step,
    setStep,
    form,
    setForm,
    saving,
    detail,
    setDetail,
    selected,
    setSelected,
    deleting,
    updatingAdvanced,
    replacementSecret,
    setReplacementSecret,
    apiBase,
    query,
    connections,
    openWizard,
    domains,
    mapping,
    step0Errors,
    step1Errors,
    allErrors,
    createConnection,
    toggleActive,
    updateAdvanced,
    replaceOidcSecret,
    deleteConnection,
    downloadMetadata,
  };
}

export type EnterpriseSsoController = ReturnType<typeof useEnterpriseSso>;
