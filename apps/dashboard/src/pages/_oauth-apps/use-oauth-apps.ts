import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OAuthApplicationJSON, PaginatedList } from "@orbitid/shared";
import { toast } from "sonner";
import { api, apiAllPages, getApiUrl, useApi } from "../../lib/api";
import { useAllOrganizations } from "../../lib/app-ownership";
import { oneTimeSecret, unwrapList } from "../_config/data";
import { errorMessage, isHttpUrl } from "../_config/settings";
import { useSettingsEditor } from "../_config/use-settings";
import { type AppForm, EMPTY_FORM, LIFETIME_LIMITS, uniqueScopes } from "./model";
import { billingPortalUrlError, billingPortalUrlValue } from "../../lib/billing";

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  end_session_endpoint?: string;
  device_authorization_endpoint?: string;
}

export function useOAuthApps() {
  const apiBase = getApiUrl();
  const query = useApi<PaginatedList<OAuthApplicationJSON>>(["oauth_applications"], "/oauth_applications", {
    queryFn: ({ signal }) => apiAllPages<OAuthApplicationJSON>("/oauth_applications", { signal }),
  });
  const applications = unwrapList<OAuthApplicationJSON>(query.data);
  const { organizations } = useAllOrganizations();
  const config = useSettingsEditor();
  const settings = config.settings;
  // Endpoints must be the ones clients reach, not the dashboard's dev proxy. Discovery is the provider's own answer.
  const discoveryQuery = useQuery<OidcDiscovery | null>({
    queryKey: ["oidc-discovery", apiBase],
    queryFn: async () => {
      const response = await fetch(`${apiBase}/.well-known/openid-configuration`);
      if (!response.ok) return null;
      const body = (await response.json()) as OidcDiscovery;
      return typeof body?.issuer === "string" ? body : null;
    },
    staleTime: 5 * 60_000,
  });
  const issuer = discoveryQuery.data?.issuer ?? apiBase;
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<AppForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [detail, setDetail] = useState<OAuthApplicationJSON | null>(null);
  const [secret, setSecret] = useState<{ title: string; clientId: string; value: string | null } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [selected, setSelected] = useState<OAuthApplicationJSON | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setSheetOpen(true);
  };
  const openEdit = (application: OAuthApplicationJSON) => {
    setForm({
      id: application.id,
      name: application.name,
      redirectUris: application.redirect_uris.length > 0 ? application.redirect_uris : [""],
      postLogoutRedirectUris: application.post_logout_redirect_uris?.length ? application.post_logout_redirect_uris : [""],
      scopes: application.scopes,
      publicClient: application.public,
      pkceRequired: application.pkce_required,
      consentScreenEnabled: application.consent_screen_enabled,
      accessTokenLifetimeSeconds: application.access_token_lifetime_seconds,
      refreshTokenLifetimeSeconds: application.refresh_token_lifetime_seconds,
      idTokenLifetimeSeconds: application.id_token_lifetime_seconds,
      groupsClaim: application.groups_claim,
      organizationId: application.organization_id ?? "",
      originalOrganizationId: application.organization_id ?? "",
      billingPortalUrl: application.billing_portal_url ?? "",
      originalBillingPortalUrl: application.billing_portal_url ?? "",
    });
    setSheetOpen(true);
  };

  const uris = form.redirectUris.map((uri) => uri.trim()).filter(Boolean);
  const logoutUris = form.postLogoutRedirectUris.map((uri) => uri.trim()).filter(Boolean);
  const formErrors: string[] = [];
  if (!form.name.trim()) formErrors.push("Application name is required.");
  if (uris.length === 0) formErrors.push("Add at least one redirect URI.");
  if (uris.some((uri) => !isHttpUrl(uri))) formErrors.push("Every redirect URI must be an absolute http(s) URL.");
  if (logoutUris.some((uri) => !isHttpUrl(uri))) formErrors.push("Every post-logout redirect URI must be an absolute http(s) URL.");
  if (form.publicClient && !form.pkceRequired) formErrors.push("Public clients must require PKCE (S256).");
  if (!form.scopes.trim()) formErrors.push("At least one scope is required.");
  const billingError = billingPortalUrlError(form.billingPortalUrl);
  if (billingError) formErrors.push(billingError);
  for (const [label, value, bounds] of [
    ["Access token lifetime", form.accessTokenLifetimeSeconds, LIFETIME_LIMITS.access],
    ["Refresh token lifetime", form.refreshTokenLifetimeSeconds, LIFETIME_LIMITS.refresh],
    ["ID token lifetime", form.idTokenLifetimeSeconds, LIFETIME_LIMITS.id],
  ] as const) {
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      formErrors.push(`${label} must be between ${bounds.min} and ${bounds.max} seconds.`);
    }
  }

  const oidcErrors: string[] = [];
  if (settings) {
    if (settings.oidcProvider.deviceCodeLifetimeSeconds < 60) oidcErrors.push("Device code lifetime must be at least 60 seconds.");
    if (settings.oidcProvider.deviceCodeIntervalSeconds < 1) oidcErrors.push("Polling interval must be at least 1 second.");
    if (settings.oidcProvider.deviceCodeIntervalSeconds >= settings.oidcProvider.deviceCodeLifetimeSeconds)
      oidcErrors.push("Polling interval must be shorter than the device code lifetime.");
    if (settings.oidcProvider.refreshTokenReuseGraceSeconds < 0 || settings.oidcProvider.refreshTokenReuseGraceSeconds > 600)
      oidcErrors.push("Refresh retry grace must be between 0 and 600 seconds.");
  }

  const saveApplication = async () => {
    if (formErrors.length > 0) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        redirect_uris: uris,
        post_logout_redirect_uris: logoutUris,
        scopes: uniqueScopes(form.scopes).join(" "),
        pkce_required: form.pkceRequired,
        consent_screen_enabled: form.consentScreenEnabled,
        access_token_lifetime_seconds: form.accessTokenLifetimeSeconds,
        refresh_token_lifetime_seconds: form.refreshTokenLifetimeSeconds,
        id_token_lifetime_seconds: form.idTokenLifetimeSeconds,
        groups_claim: form.groupsClaim,
      };
      if (!form.id) body.public = form.publicClient;
      // Send the owner only when the operator chose one or changed it (`null` makes it instance-wide), so saving
      // other fields never overwrites an owner someone else changed meanwhile.
      if (form.organizationId !== form.originalOrganizationId) body.organization_id = form.organizationId || null;
      // The billing portal follows the same rule (`null` clears it).
      const billingPortalUrl = billingPortalUrlValue(form.billingPortalUrl);
      if (billingPortalUrl !== billingPortalUrlValue(form.originalBillingPortalUrl)) body.billing_portal_url = billingPortalUrl;
      const response = await api<unknown>(form.id ? "PATCH" : "POST", form.id ? `/oauth_applications/${form.id}` : "/oauth_applications", body);
      await query.refetch();
      setSheetOpen(false);
      const created = response && typeof response === "object" ? (response as Record<string, unknown>) : null;
      const returned = ((created?.data ?? created) ?? null) as Record<string, unknown> | null;
      const clientId = typeof returned?.client_id === "string" ? returned.client_id : "";
      const secretValue = oneTimeSecret(response);
      if (!form.id) {
        setSecret({ title: `Application ${body.name} created`, clientId, value: secretValue });
      } else if (secretValue) {
        setSecret({ title: `Application ${body.name} updated`, clientId, value: secretValue });
      }
      toast.success(form.id ? "OAuth application updated" : "OAuth application created");
    } catch (error) {
      toast.error("Could not save OAuth application", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const rotateSecret = async () => {
    if (!detail) return;
    setRotating(true);
    try {
      const response = await api<unknown>("POST", `/oauth_applications/${detail.id}/rotate_secret`);
      setSecret({ title: `New client secret for ${detail.name}`, clientId: detail.client_id, value: oneTimeSecret(response) });
      await query.refetch();
      toast.success("Client secret rotated");
    } catch (error) {
      toast.error("Could not rotate client secret", { description: errorMessage(error) });
    } finally {
      setRotating(false);
    }
  };

  const deleteApplication = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await api("DELETE", `/oauth_applications/${selected.id}`);
      await query.refetch();
      if (detail?.id === selected.id) setDetail(null);
      toast.success("OAuth application deleted");
      setSelected(null);
    } catch (error) {
      toast.error("Could not delete application", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  return {
    sheetOpen,
    setSheetOpen,
    form,
    setForm,
    saving,
    detail,
    setDetail,
    secret,
    setSecret,
    rotating,
    selected,
    setSelected,
    deleting,
    apiBase,
    issuer,
    discovery: discoveryQuery.data ?? null,
    query,
    applications,
    organizations,
    config,
    settings,
    openCreate,
    openEdit,
    formErrors,
    oidcErrors,
    saveApplication,
    rotateSecret,
    deleteApplication,
  };
}

export type OAuthAppsController = ReturnType<typeof useOAuthApps>;
