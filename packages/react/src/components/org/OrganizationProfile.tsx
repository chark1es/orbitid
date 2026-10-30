import { Children, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { Alert, AlertDescription, Badge, Button } from "@orbitid/ui";
import { useLocalizations } from "../../localization";
import { useRouter } from "../../lib/routing";
import { APIKeys } from "./APIKeys";
import { OrgAvatar } from "./_shared/OrgAvatar";
import { OrgRoot } from "./_shared/OrgRoot";
import { PermissionGate } from "./_shared/PermissionGate";
import { MembersSection } from "./sections/MembersSection";
import { useDebouncedValue, useOrganizationRoles, useOrgScope, useSelfUser } from "./_shared/hooks";
import { ORG_PERMISSIONS, roleLabel } from "./_shared/utils";
import type {
  CommonOrgProps,
  OrgProfileCustomLinkProps,
  OrgProfileCustomPageProps,
} from "./_shared/types";
import { GeneralSection } from "./OrganizationProfileSections";

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

function normalizeSlug(value: string): string {
  const slug = value.replace(/^\/+/, "").replace(/\/+$/, "");
  return slug.length > 0 ? slug : BUILT_IN_SLUGS[0]!;
}

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
