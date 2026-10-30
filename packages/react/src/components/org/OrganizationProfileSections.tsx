import { useEffect, useState } from "react";
import { Button, Input, Label, Separator } from "@orbitid/ui";
import { ShieldAlertIcon, UploadIcon } from "lucide-react";
import { useLocalizations } from "../../localization";
import { useUser } from "../../hooks";
import type { OrganizationResource } from "../../provider";
import { ConfirmDialog } from "./_shared/ConfirmDialog";
import { ErrorBanner } from "./_shared/Feedback";
import { OrgAvatar } from "./_shared/OrgAvatar";
import { DomainsSection } from "./sections/DomainsSection";
import {
  useAsyncAction,
  useNavigate,
  useOrganizationCreator,
  useOrgErrorText,
  type OrgScope,
} from "./_shared/hooks";
import { readFileAsDataUrl, slugify } from "./_shared/utils";

interface GeneralSectionProps {
  organization: OrganizationResource;
  canManage: boolean;
  canReadDomains: boolean;
  canManageDomains: boolean;
  canDelete: boolean;
  settings: OrgScope["settings"];
  domains: OrgScope["domains"];
  afterLeaveOrganizationUrl?: string;
  onLeft?: () => void;
}

export function GeneralSection({
  organization,
  canManage,
  canReadDomains,
  canManageDomains,
  canDelete,
  settings,
  domains,
  afterLeaveOrganizationUrl,
  onLeft,
}: GeneralSectionProps) {
  const { t } = useLocalizations();
  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug);
  const [saved, setSaved] = useState<OrganizationResource | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const current = saved?.id === organization.id ? saved : organization;

  useEffect(() => {
    setName(organization.name);
    setSlug(organization.slug);
    setSaved(null);
    setSaveMessage(null);
  }, [organization.id, organization.name, organization.slug, organization.updatedAt]);

  const saveAction = useAsyncAction(async (next: { name: string; slug?: string }) => {
    const updated = await organization.update(next);
    setSaved(updated);
    setSaveMessage(t("organizationProfile.profilePage.successMessage"));
    return updated;
  });
  const logoAction = useAsyncAction(async (file: File | null) => {
    const updated = file ? await organization.setLogo({ file }) : await organization.removeLogo();
    setSaved(updated);
    setLogoPreview(null);
    return updated;
  });
  const saveError = useOrgErrorText(saveAction.error);
  const logoError = useOrgErrorText(logoAction.error);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label={t("organizationProfile.profilePage.title")}>
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">{t("organizationProfile.profilePage.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("organizationProfile.profilePage.subtitle")}
          </p>
        </div>

        {!canManage ? (
          <p className="text-sm text-muted-foreground">
            {t("organizationProfile.profilePage.readOnly")}
          </p>
        ) : null}

        <ErrorBanner message={saveError} />
        <ErrorBanner message={logoError} />

        <div className="flex flex-wrap items-center gap-3">
          <OrgAvatar
            name={current.name}
            imageUrl={logoPreview ?? current.imageUrl}
            hasImage={logoPreview ? true : current.hasImage}
            size="lg"
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor="org-logo">{t("organizationProfile.profilePage.imageFormTitle")}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm">
                <label htmlFor="org-logo" className="cursor-pointer">
                  <UploadIcon aria-hidden="true" />
                  {t("organizationProfile.profilePage.imageFormAction__upload")}
                </label>
              </Button>
              <input
                id="org-logo"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                disabled={!canManage || logoAction.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void readFileAsDataUrl(file).then(setLogoPreview);
                  void logoAction.run(file);
                }}
              />
              {current.hasImage ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!canManage || logoAction.isPending}
                  onClick={() => void logoAction.run(null)}
                >
                  {t("organizationProfile.profilePage.imageFormAction__remove")}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmedName = name.trim();
            if (!trimmedName) return;
            if (settings.slugEnabled && slug.trim()) setSlug(slugify(slug));
            void saveAction.run({
              name: trimmedName,
              ...(settings.slugEnabled && slug.trim() ? { slug: slugify(slug) } : {}),
            });
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="org-name">{t("formFieldLabel__organizationName")}</Label>
            <Input
              id="org-name"
              value={name}
              disabled={!canManage || saveAction.isPending}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {settings.slugEnabled ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="org-slug">{t("formFieldLabel__organizationSlug")}</Label>
              <Input
                id="org-slug"
                value={slug}
                disabled={!canManage || saveAction.isPending}
                onChange={(event) => setSlug(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("formFieldHintText__slug")}</p>
            </div>
          ) : null}
          {canManage ? (
            <div className="flex items-center justify-end gap-3">
              {saveMessage ? (
                <span className="text-sm text-muted-foreground" role="status">
                  {saveMessage}
                </span>
              ) : null}
              <Button type="submit" disabled={saveAction.isPending || !name.trim()}>
                {saveAction.isPending ? t("status.loading") : t("formButtonPrimary__save")}
              </Button>
            </div>
          ) : null}
        </form>
      </section>

      {settings.domainsEnabled && canReadDomains ? (
        <>
          <Separator />
          <DomainsSection organization={organization} domains={domains} canManage={canManageDomains} />
        </>
      ) : null}

      <Separator />
      <DangerSection
        organization={current}
        canDelete={canDelete}
        afterLeaveOrganizationUrl={afterLeaveOrganizationUrl}
        onLeft={onLeft}
      />
    </div>
  );
}

interface DangerSectionProps {
  organization: OrganizationResource;
  canDelete: boolean;
  afterLeaveOrganizationUrl?: string;
  onLeft?: () => void;
}

function DangerSection({
  organization,
  canDelete,
  afterLeaveOrganizationUrl,
  onLeft,
}: DangerSectionProps) {
  const { t } = useLocalizations();
  const { user } = useUser();
  const navigate = useNavigate();
  const { setActive } = useOrganizationCreator();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const leaveAction = useAsyncAction(async () => {
    if (!user) return false;
    await user.leaveOrganization(organization.id);
    await setActive({ organization: null });
    return true;
  });
  const deleteAction = useAsyncAction(async () => {
    await organization.destroy();
    await setActive({ organization: null });
    return true;
  });
  const leaveError = useOrgErrorText(leaveAction.error);
  const deleteError = useOrgErrorText(deleteAction.error);

  const afterLeave = () => {
    onLeft?.();
    navigate(afterLeaveOrganizationUrl ?? "/");
  };

  return (
    <section className="flex flex-col gap-3" aria-label={t("organizationProfile.dangerSection.title")}>
      <div className="flex items-center gap-2">
        <ShieldAlertIcon className="size-4 text-destructive" aria-hidden="true" />
        <h3 className="font-medium text-destructive">{t("organizationProfile.dangerSection.title")}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{t("organizationProfile.dangerSection.warning")}</p>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
        <div className="flex flex-col">
          <span className="font-medium">
            {t("organizationProfile.dangerSection.leaveOrganization")}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("organizationProfile.dangerSection.leaveOrganizationSubtitle")}
          </span>
        </div>
        <Button type="button" variant="outline" onClick={() => setLeaveOpen(true)}>
          {t("organizationProfile.dangerSection.leaveOrganization")}
        </Button>
      </div>

      {canDelete ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/40 p-3">
          <div className="flex flex-col">
            <span className="font-medium">
              {t("organizationProfile.dangerSection.deleteOrganization")}
            </span>
            <span className="text-sm text-muted-foreground">
              {t("organizationProfile.dangerSection.deleteOrganizationSubtitle")}
            </span>
          </div>
          <Button type="button" variant="destructive" onClick={() => setDeleteOpen(true)}>
            {t("organizationProfile.dangerSection.deleteOrganizationButton")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("organizationProfile.dangerSection.deleteDisabled")}
        </p>
      )}

      <ConfirmDialog
        open={leaveOpen}
        onOpenChange={setLeaveOpen}
        title={t("organizationProfile.dangerSection.leaveOrganizationTitle")}
        description={t("organizationProfile.dangerSection.leaveOrganizationSubtitle")}
        confirmLabel={t("organizationProfile.dangerSection.leaveOrganization")}
        destructive
        error={leaveError}
        onConfirm={async () => {
          const left = await leaveAction.run();
          if (!left) return;
          setLeaveOpen(false);
          afterLeave();
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("organizationProfile.dangerSection.deleteOrganizationTitle")}
        description={t("organizationProfile.dangerSection.deleteOrganizationSubtitle")}
        confirmationPhrase={organization.name}
        confirmationLabel={t("organizationProfile.dangerSection.deleteConfirmationLabel")}
        confirmLabel={t("organizationProfile.dangerSection.deleteOrganizationButton")}
        destructive
        error={deleteError}
        onConfirm={async () => {
          const deleted = await deleteAction.run();
          if (!deleted) return;
          setDeleteOpen(false);
          afterLeave();
        }}
      />
    </section>
  );
}
