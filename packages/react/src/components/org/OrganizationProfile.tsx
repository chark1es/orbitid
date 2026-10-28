import {
  Children,
  isValidElement,
  useEffect,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Input,
  Label,
  Separator,
} from "@orbitid/ui";
import { ShieldAlertIcon, UploadIcon } from "lucide-react";
import { useLocalizations } from "../../localization";
import { useRouter } from "../../lib/routing";
import { useUser } from "../../hooks";
import type { OrganizationResource } from "../../provider";
import { APIKeys } from "./APIKeys";
import { ConfirmDialog } from "./_shared/ConfirmDialog";
import { ErrorBanner } from "./_shared/Feedback";
import { OrgAvatar } from "./_shared/OrgAvatar";
import { OrgRoot } from "./_shared/OrgRoot";
import { PermissionGate } from "./_shared/PermissionGate";
import { DomainsSection } from "./sections/DomainsSection";
import { MembersSection } from "./sections/MembersSection";
import {
  useAsyncAction,
  useDebouncedValue,
  useNavigate,
  useOrganizationCreator,
  useOrganizationRoles,
  useOrgErrorText,
  useOrgScope,
  useSelfUser,
  type OrgScope,
} from "./_shared/hooks";
import { ORG_PERMISSIONS, readFileAsDataUrl, roleLabel, slugify } from "./_shared/utils";
import type {
  CommonOrgProps,
  OrgProfileCustomLinkProps,
  OrgProfileCustomPageProps,
} from "./_shared/types";

export interface OrganizationProfileProps extends CommonOrgProps {
  /** `hash` (default), `path` or in-memory routing for the nav sections. */
  routing?: "path" | "hash" | "virtual";
  /** Base path used by `routing="path"`/`"hash"`. */
  path?: string;
  afterLeaveOrganizationUrl?: string;
  /** Custom `<OrganizationProfile.Page>` / `.Link` elements. */
  children?: ReactNode;
  /** Internal: modal hosts close their dialog when the user leaves or deletes the organization. */
  onLeaveOrganization?: () => void;
}

interface OrgProfileNavSection {
  slug: string;
  label: string;
  labelIcon?: ReactNode;
  content: ReactNode;
}

const BUILT_IN_SLUGS = ["general", "members", "api-keys"];

function OrganizationProfilePage(_props: OrgProfileCustomPageProps) {
  return null;
}

function OrganizationProfileLink(_props: OrgProfileCustomLinkProps) {
  return null;
}

/**
 * Full organization profile: general settings (name/slug/logo, domains, danger zone), members
 * (members / invitations / requests) and API keys, with `Page`/`Link` nav customization.
 */
function OrganizationProfileRoot(props: OrganizationProfileProps) {
  return (
    <OrgRoot appearance={props.appearance} className={props.className}>
      <OrganizationProfileView {...props} />
    </OrgRoot>
  );
}

export const OrganizationProfile = Object.assign(OrganizationProfileRoot, {
  Page: OrganizationProfilePage,
  Link: OrganizationProfileLink,
});

function OrganizationProfileView({
  routing = "hash",
  path,
  afterLeaveOrganizationUrl,
  children,
  onLeaveOrganization,
}: OrganizationProfileProps) {
  const { t } = useLocalizations();
  const router = useRouter({ routing, path, startPath: "/general" });
  const [memberQuery, setMemberQuery] = useState("");
  const debouncedQuery = useDebouncedValue(memberQuery, 250);
  const scope = useOrgScope({ memberQuery: debouncedQuery, pageSize: 10 });
  const { organization, membership, settings, isLoaded, can } = scope;
  const self = useSelfUser();
  const { roles } = useOrganizationRoles(organization, Boolean(organization));

  const customPages = Children.toArray(children).filter(
    (child): child is ReactElement<OrgProfileCustomPageProps> =>
      isValidElement(child) && child.type === OrganizationProfilePage,
  );
  const customLinks = Children.toArray(children).filter(
    (child): child is ReactElement<OrgProfileCustomLinkProps> =>
      isValidElement(child) && child.type === OrganizationProfileLink,
  );

  const canManageMembers = can(ORG_PERMISSIONS.membershipsManage);
  const canReadDomains = can(ORG_PERMISSIONS.domainsRead);
  const canManageDomains = can(ORG_PERMISSIONS.domainsManage);
  const canManageProfile = can(ORG_PERMISSIONS.profileManage);
  const canDeleteOrganization = can(ORG_PERMISSIONS.profileDelete);

  if (!isLoaded) {
    return (
      <div className="flex flex-col gap-3 py-6" aria-busy="true">
        <p className="text-sm text-muted-foreground">{t("status.loading")}</p>
      </div>
    );
  }

  if (!organization) {
    return (
      <Alert>
        <AlertDescription>{t("organizationProfile.noOrganization")}</AlertDescription>
      </Alert>
    );
  }

  const sections: OrgProfileNavSection[] = [
    {
      slug: "general",
      label: t("organizationProfile.navbar.general"),
      content: (
        <GeneralSection
          organization={organization}
          canManage={canManageProfile}
          canReadDomains={canReadDomains}
          canManageDomains={canManageDomains}
          canDelete={canDeleteOrganization && organization.adminDeleteEnabled !== false}
          settings={settings}
          domains={scope.domains}
          afterLeaveOrganizationUrl={afterLeaveOrganizationUrl}
          onLeft={onLeaveOrganization}
        />
      ),
    },
    {
      slug: "members",
      label: t("organizationProfile.navbar.members"),
      content: (
        <MembersSection
          organization={organization}
          scope={scope}
          roles={roles}
          selfUserId={self.id}
          canManage={canManageMembers}
          memberQuery={memberQuery}
          onMemberQueryChange={setMemberQuery}
        />
      ),
    },
  ];

  if (canManageProfile) {
    sections.push({
      slug: "api-keys",
      label: t("organizationProfile.navbar.apiKeys"),
      content: (
        <PermissionGate membership={membership} permission={ORG_PERMISSIONS.profileManage}>
          <APIKeys type="organization" showDescription />
        </PermissionGate>
      ),
    });
  }

  for (const page of customPages) {
    const slug = normalizeSlug(page.props.url);
    if (sections.some((section) => section.slug === slug)) continue;
    sections.push({
      slug,
      label: page.props.label,
      labelIcon: page.props.labelIcon,
      content: page.props.children,
    });
  }

  const currentSlug = normalizeSlug(router.path);
  const activeSection =
    sections.find((section) => section.slug === currentSlug) ?? sections[0]!;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <OrgAvatar
          name={organization.name}
          imageUrl={organization.imageUrl}
          hasImage={organization.hasImage}
          size="md"
        />
        <div className="flex min-w-0 flex-col">
          <h2 className="truncate text-lg font-semibold">{organization.name}</h2>
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-muted-foreground">{organization.slug}</span>
            {membership ? (
              <Badge variant="secondary">
                {roleLabel(membership.role, membership.roleName, t)}
              </Badge>
            ) : null}
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-6 md:flex-row">
        <nav
          aria-label={t("organizationProfile.navbar.title")}
          className="flex flex-row gap-1 overflow-x-auto pb-1 md:w-44 md:flex-col md:overflow-visible md:pb-0"
        >
          {sections.map((section) => {
            const active = section.slug === activeSection.slug;
            return (
              <Button
                key={section.slug}
                type="button"
                variant={active ? "secondary" : "ghost"}
                size="sm"
                className="justify-start whitespace-nowrap"
                aria-current={active ? "page" : undefined}
                onClick={() => router.navigate(`/${section.slug}`)}
              >
                {section.labelIcon}
                {section.label}
              </Button>
            );
          })}
          {customLinks.map((link) => (
            <Button key={link.props.url} asChild variant="ghost" size="sm" className="justify-start">
              <a href={link.props.url}>
                {link.props.labelIcon}
                {link.props.label}
              </a>
            </Button>
          ))}
        </nav>

        <div className="min-w-0 flex-1">{activeSection.content}</div>
      </div>
    </div>
  );
}

function normalizeSlug(value: string): string {
  const slug = value.replace(/^\/+/, "").replace(/\/+$/, "");
  return slug.length > 0 ? slug : BUILT_IN_SLUGS[0]!;
}

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

function GeneralSection({
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
                accept="image/png,image/jpeg,image/svg+xml,image/webp"
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
