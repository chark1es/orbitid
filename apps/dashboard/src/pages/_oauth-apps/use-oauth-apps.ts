import { useState } from "react";
import type { OAuthApplicationJSON, PaginatedList } from "@orbitid/shared";
import { toast } from "sonner";
import { api, getApiUrl, useApi } from "../../lib/api";
import { oneTimeSecret, unwrapList } from "../_config/data";
import { errorMessage, isHttpUrl } from "../_config/settings";
import { useSettingsEditor } from "../_config/use-settings";
import { type AppForm, EMPTY_FORM } from "./model";

export function useOAuthApps() {
  const apiBase = getApiUrl();
  const query = useApi<PaginatedList<OAuthApplicationJSON>>(["oauth_applications"], "/oauth_applications?limit=100");
  const applications = unwrapList<OAuthApplicationJSON>(query.data);
  const config = useSettingsEditor();
  const settings = config.settings;
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
      scopes: application.scopes,
      publicClient: application.public,
      pkceRequired: application.pkce_required,
      consentScreenEnabled: application.consent_screen_enabled,
    });
    setSheetOpen(true);
  };

  const uris = form.redirectUris.map((uri) => uri.trim()).filter(Boolean);
  const formErrors: string[] = [];
  if (!form.name.trim()) formErrors.push("Application name is required.");
  if (uris.length === 0) formErrors.push("Add at least one redirect URI.");
  if (uris.some((uri) => !isHttpUrl(uri))) formErrors.push("Every redirect URI must be an absolute http(s) URL.");
  if (form.publicClient && !form.pkceRequired) formErrors.push("Public clients must require PKCE (S256).");
  if (!form.scopes.trim()) formErrors.push("At least one scope is required.");

  const oidcErrors: string[] = [];
  if (settings) {
    if (settings.oidcProvider.deviceCodeLifetimeSeconds < 60) oidcErrors.push("Device code lifetime must be at least 60 seconds.");
    if (settings.oidcProvider.deviceCodeIntervalSeconds < 1) oidcErrors.push("Polling interval must be at least 1 second.");
    if (settings.oidcProvider.deviceCodeIntervalSeconds >= settings.oidcProvider.deviceCodeLifetimeSeconds)
      oidcErrors.push("Polling interval must be shorter than the device code lifetime.");
  }

  const saveApplication = async () => {
    if (formErrors.length > 0) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        redirect_uris: uris,
        scopes: form.scopes.trim(),
        pkce_required: form.pkceRequired,
        consent_screen_enabled: form.consentScreenEnabled,
      };
      if (!form.id) body.public = form.publicClient;
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
    query,
    applications,
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
