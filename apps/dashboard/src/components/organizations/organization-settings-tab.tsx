import { useRef, useState, type ChangeEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  Input,
  Label,
  Switch,
} from "@orbitid/ui";
import { ImagePlus, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { OrganizationJSON } from "@orbitid/shared";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { uploadOrganizationLogo } from "../../lib/uploads";
import { UserAvatar } from "../shared/user-avatar";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Panel, Section } from "../shared/section";

export function OrganizationSettingsTab({ org, onChanged }: { org: OrganizationJSON; onChanged: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [maxMemberships, setMaxMemberships] = useState(String(org.max_allowed_memberships));
  const [adminDelete, setAdminDelete] = useState(org.admin_delete_enabled);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirty =
    name !== org.name ||
    slug !== org.slug ||
    maxMemberships !== String(org.max_allowed_memberships) ||
    adminDelete !== org.admin_delete_enabled;

  async function save() {
    setSaving(true);
    try {
      await api("PATCH", `/organizations/${org.id}`, {
        name: name.trim(),
        slug: slug.trim(),
        max_allowed_memberships: Number(maxMemberships),
        admin_delete_enabled: adminDelete,
      });
      toast.success("Organization updated");
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function onLogoChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await uploadOrganizationLogo(org.id, file);
      toast.success("Logo updated");
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  async function deleteOrganization() {
    setDeleting(true);
    try {
      await api("DELETE", `/organizations/${org.id}`);
      toast.success("Organization deleted");
      navigate("/organizations", { replace: true });
    } catch (error) {
      toast.error(errorMessage(error));
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <Section title="Settings" description="Name, slug, capacity and logo for this organization.">
        <Panel className="p-4">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="org-settings-name">Name</Label>
                <Input id="org-settings-name" value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-settings-slug">Slug</Label>
                <Input id="org-settings-slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="org-settings-max">Max memberships</Label>
                <Input
                  id="org-settings-max"
                  type="number"
                  min={0}
                  title="0 means no limit"
                  value={maxMemberships}
                  onChange={(event) => setMaxMemberships(event.target.value)}
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-[3px] border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="org-settings-admin-delete">Admins can delete</Label>
                <p className="text-xs leading-5 text-muted-foreground">
                  Allow <code className="font-data">org:admin</code> members to delete this organization.
                </p>
              </div>
              <Switch id="org-settings-admin-delete" checked={adminDelete} onCheckedChange={setAdminDelete} />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <div className="flex min-w-0 items-center gap-3">
                <UserAvatar name={org.name} imageUrl={org.image_url} size="lg" className="size-12" />
                <div className="min-w-0 space-y-0.5">
                  <h3 className="text-sm font-medium">Logo</h3>
                  <p className="text-xs leading-5 text-muted-foreground">Shown in the organization switcher and profile.</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={(e) => void onLogoChange(e)} />
                <Button size="sm" variant="outline" disabled={uploading} onClick={() => fileInput.current?.click()}>
                  {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <ImagePlus aria-hidden />}
                  {uploading ? "Uploading…" : "Upload logo"}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-xs text-muted-foreground">
                Created <span className="font-data">{new Date(org.created_at).toLocaleString()}</span> · Updated{" "}
                <span className="font-data">{new Date(org.updated_at).toLocaleString()}</span>
              </p>
              <Button onClick={() => void save()} disabled={!dirty || saving}>
                {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Save changes
              </Button>
            </div>
          </div>
        </Panel>
      </Section>

      <Section
        title="Danger zone"
        description="Deleting an organization removes memberships, invitations and domains permanently."
      >
        <Panel className="border-signal/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-sm font-medium">Delete {org.name}</p>
              <p className="max-w-[60ch] text-sm leading-6 text-muted-foreground">
                Members lose every role granted here, and the name and slug are released for reuse.
              </p>
            </div>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden /> Delete organization
            </Button>
          </div>
        </Panel>
      </Section>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this organization permanently?"
        description={`${org.name} and every membership, invitation and domain will be removed.`}
        confirmLabel="Delete organization"
        destructive
        pending={deleting}
        onConfirm={() => void deleteOrganization()}
      />
    </div>
  );
}
