import { useContext, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  OVERLAY_WIDTH,
  cn,
} from "@orbitid/ui";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
} from "lucide-react";
import { useLocalizations } from "../../localization";
import { useOrbitID } from "../../hooks";
import { OrbitIDOptionsContext } from "../../provider";
import type {
  OrganizationResource,
  OrganizationSuggestionResource,
  UserResource,
} from "../../provider";
import { acceptOrganizationInvitation } from "./_shared/fapi";
import { EmptyState, ErrorBanner } from "./_shared/Feedback";
import { OrgAvatar } from "./_shared/OrgAvatar";
import { OrgRoot } from "./_shared/OrgRoot";
import { OrganizationProfile } from "./OrganizationProfile";
import { CreateOrganization } from "./CreateOrganization";
import {
  useAsyncAction,
  useNavigate,
  useOrgErrorText,
  useOrgScope,
  useOrgSettings,
  useSelfUser,
  useUserOrgScope,
} from "./_shared/hooks";
import { fillUrlTemplate, resolveRedirect, roleLabel } from "./_shared/utils";
import type { CommonOrgProps, RedirectUrl } from "./_shared/types";
import { usePortalClass } from "../auth/_shared/appearance";
import { useElementProps } from "../../appearance";

export interface OrganizationSwitcherProps extends CommonOrgProps {
  /** Hide the personal account entry (forced organizations). */
  hidePersonal?: boolean;
  afterCreateOrganizationUrl?: RedirectUrl<OrganizationResource>;
  afterSelectOrganizationUrl?: RedirectUrl<OrganizationResource>;
  afterSelectPersonalUrl?: RedirectUrl<UserResource | null>;
  /** Used by the embedded profile when the user leaves from the modal. */
  afterLeaveOrganizationUrl?: string;
  createOrganizationMode?: "modal" | "navigation";
  organizationProfileMode?: "modal" | "navigation";
  /** Navigation-mode destination for "Create organization". */
  createOrganizationUrl?: string;
  /** Navigation-mode destination for "Manage organization". */
  organizationProfileUrl?: string;
  skipInvitationScreen?: boolean;
}

/**
 * Active organization trigger with a popover listing the user's memberships, pending
 * invitations, suggestions, the personal account and the create/manage actions.
 */
export function OrganizationSwitcher(props: OrganizationSwitcherProps) {
  return (
    <OrgRoot appearance={props.appearance} className={cn("w-auto min-w-0 max-w-full", props.className)} whenDisabled="hidden">
      <OrganizationSwitcherView {...props} />
    </OrgRoot>
  );
}

function OrganizationSwitcherView({
  hidePersonal,
  afterCreateOrganizationUrl,
  afterSelectOrganizationUrl,
  afterSelectPersonalUrl,
  afterLeaveOrganizationUrl,
  createOrganizationMode = "modal",
  organizationProfileMode = "modal",
  createOrganizationUrl,
  organizationProfileUrl,
  skipInvitationScreen,
}: OrganizationSwitcherProps) {
  const portalClass = usePortalClass();
  const ep = useElementProps();
  const { t } = useLocalizations();
  const instance = useOrbitID();
  const options = useContext(OrbitIDOptionsContext);
  const navigate = useNavigate();
  const createUrl = createOrganizationUrl ?? options.createOrganizationUrl ?? "/create-organization";
  const profileUrl = organizationProfileUrl ?? options.organizationProfileUrl ?? "/organization";
  const settings = useOrgSettings();
  const self = useSelfUser();
  const { organization, membership, isLoaded } = useOrgScope({
    memberships: false,
    invitations: false,
    domains: false,
    membershipRequests: false,
  });
  const list = useUserOrgScope();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  const selectAction = useAsyncAction(async (next: OrganizationResource | null) => {
    await list.setActive({ organization: next });
    setOpen(false);
    return true;
  });
  const acceptAction = useAsyncAction(async (invitationId: string, organizationId?: string) => {
    await acceptOrganizationInvitation(instance, { id: invitationId });
    await Promise.all([list.invitations.revalidate(), list.memberships.revalidate()]);
    if (organizationId) await list.setActive({ organization: organizationId });
    setOpen(false);
    return organizationId ?? null;
  });

  const redirectAfterAccept = async (organizationId?: string | null) => {
    if (!organizationId || !afterSelectOrganizationUrl) return;
    const organization = await instance.getOrganization(organizationId).catch(() => null);
    if (!organization) return;
    const url = resolveRedirect(afterSelectOrganizationUrl, organization);
    if (url) navigate(fillUrlTemplate(url, { id: organization.id, slug: organization.slug }));
  };
  const suggestionAction = useAsyncAction(async (suggestion: OrganizationSuggestionResource) => {
    await suggestion.accept();
    await list.memberships.revalidate();
    await list.setActive({ organization: suggestion.publicOrganizationData.id });
    setOpen(false);
  });
  const error = useOrgErrorText(
    selectAction.error ?? acceptAction.error ?? suggestionAction.error,
  );
  const listError = useOrgErrorText(
    list.memberships.error ?? list.invitations.error ?? list.suggestions.error,
  );

  const memberships = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return list.memberships.data;
    return list.memberships.data.filter(
      (item) =>
        item.organization.name.toLowerCase().includes(term) ||
        item.organization.slug.toLowerCase().includes(term),
    );
  }, [list.memberships.data, query]);

  const activeName = organization ? organization.name : t("organizationSwitcher.personalWorkspace");
  const activeRole =
    organization && membership ? roleLabel(membership.role, membership.roleName, t) : null;
  const showPersonal = !hidePersonal && !settings.forceOrganizationSelection;

  const handleSelect = async (next: OrganizationResource | null) => {
    const ok = await selectAction.run(next);
    if (!ok) return;
    const url = next
      ? resolveRedirect(afterSelectOrganizationUrl, next)
      : resolveRedirect(afterSelectPersonalUrl, self.user);
    if (url) {
      navigate(fillUrlTemplate(url, { id: next?.id, slug: next?.slug }));
    }
  };

  if (!isLoaded) {
    return (
      <Button variant="ghost" className="gap-2" disabled aria-label={t("status.loading")}>
        <OrgAvatar name={activeName} />
        <span className="truncate">{t("status.loading")}</span>
      </Button>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            {...ep("organizationSwitcherTrigger", "h-auto min-w-0 max-w-full justify-start gap-2 px-2 py-1.5 sm:max-w-[16rem]")}
            aria-label={t("organizationSwitcher.triggerLabel")}
            aria-expanded={open}
          >
            {organization ? (
              <OrgAvatar
                name={organization.name}
                imageUrl={organization.imageUrl}
                hasImage={organization.hasImage}
              />
            ) : (
              <OrgAvatar name={self.name || "?"} />
            )}
            {/* Below sm the trigger is the avatar and the chevron: the name is the widest thing in a
                375px header and it is repeated at the top of the popover. */}
            <span className="hidden min-w-0 flex-col items-start sm:flex">
              <span className="min-w-0 max-w-[10rem] truncate font-medium">{activeName}</span>
              {activeRole ? (
                <span className="truncate text-xs text-muted-foreground">{activeRole}</span>
              ) : null}
            </span>
            <ChevronsUpDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" {...ep("organizationSwitcherPopover", portalClass("w-80 p-2"))}>
          <div className="flex flex-col gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("organizationSwitcher.searchPlaceholder")}
              aria-label={t("organizationSwitcher.searchPlaceholder")}
              className="h-8"
            />

            <ErrorBanner message={error ?? listError} />

            <section aria-label={t("organizationSwitcher.title")} className="flex flex-col gap-0.5">
              {memberships.length === 0 ? (
                <EmptyState>
                  {query.trim()
                    ? t("organizationSwitcher.notFound")
                    : t("organizationSwitcher.noOrganizationMemberships")}
                </EmptyState>
              ) : (
                memberships.map((item) => {
                  const isActive = organization?.id === item.organization.id;
                  return (
                    <Button
                      key={item.id}
                      variant="ghost"
                      className="h-auto w-full min-w-0 justify-start gap-2 px-2 py-1.5"
                      disabled={selectAction.isPending}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => void handleSelect(item.organization)}
                    >
                      <OrgAvatar
                        name={item.organization.name}
                        imageUrl={item.organization.imageUrl}
                        hasImage={item.organization.hasImage}
                      />
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate">{item.organization.name}</span>
                        <Badge variant="secondary" className="shrink-0">
                          {roleLabel(item.role, item.roleName, t)}
                        </Badge>
                      </span>
                      {isActive ? <CheckIcon className="size-4" aria-hidden="true" /> : null}
                    </Button>
                  );
                })
              )}
            </section>

            {list.invitations.data.length > 0 ? (
              <>
                <Separator />
                <section
                  aria-label={t("organizationSwitcher.invitations")}
                  className="flex flex-col gap-0.5"
                >
                  <p className="px-2 text-xs font-medium text-muted-foreground">
                    {t("organizationSwitcher.invitations")}
                  </p>
                  {list.invitations.data.map((invitation) => {
                    const organizationName =
                      invitation.organizationName ?? invitation.organization?.name ?? null;
                    const organizationImage =
                      invitation.organizationImageUrl ?? invitation.organization?.imageUrl ?? null;
                    return (
                      <div
                        key={invitation.id}
                        className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5"
                      >
                        {organizationName ? (
                          <OrgAvatar name={organizationName} imageUrl={organizationImage} size="xs" />
                        ) : null}
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm">
                            {organizationName ?? invitation.emailAddress}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {roleLabel(invitation.role, invitation.roleName, t)}
                          </span>
                          {organizationName ? (
                            <span className="truncate text-xs text-muted-foreground">
                              {invitation.emailAddress}
                            </span>
                          ) : null}
                        </span>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={acceptAction.isPending}
                          onClick={() => {
                            void acceptAction
                              .run(invitation.id, invitation.organizationId)
                              .then(redirectAfterAccept);
                          }}
                        >
                          {t("organizationSwitcher.action__invitationAccept")}
                        </Button>
                      </div>
                    );
                  })}
                </section>
              </>
            ) : null}

            {list.suggestions.data.length > 0 ? (
              <>
                <Separator />
                <section
                  aria-label={t("organizationSwitcher.suggestions")}
                  className="flex flex-col gap-0.5"
                >
                  <p className="px-2 text-xs font-medium text-muted-foreground">
                    {t("organizationSwitcher.suggestions")}
                  </p>
                  {list.suggestions.data.map((suggestion) => (
                    <div
                      key={suggestion.id}
                      className="flex min-w-0 items-center justify-between gap-2 rounded-md px-2 py-1.5"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <OrgAvatar
                          name={suggestion.publicOrganizationData.name}
                          imageUrl={suggestion.publicOrganizationData.imageUrl}
                          hasImage={suggestion.publicOrganizationData.hasImage}
                        />
                        <span className="truncate text-sm">
                          {suggestion.publicOrganizationData.name}
                        </span>
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={suggestionAction.isPending}
                        onClick={() => {
                          void suggestionAction.run(suggestion);
                        }}
                      >
                        {t("organizationSwitcher.action__suggestionsAccept")}
                      </Button>
                    </div>
                  ))}
                </section>
              </>
            ) : null}

            <Separator />

            <div className="flex flex-col gap-0.5">
              {showPersonal ? (
                <Button
                  variant="ghost"
                  className="justify-start gap-2 px-2"
                  aria-current={organization ? undefined : "true"}
                  disabled={selectAction.isPending}
                  onClick={() => void handleSelect(null)}
                >
                  <UserIcon className="size-4" aria-hidden="true" />
                  <span className="truncate">{t("organizationSwitcher.personalWorkspace")}</span>
                  {organization ? null : <CheckIcon className="ml-auto size-4" aria-hidden="true" />}
                </Button>
              ) : null}
              {organization ? (
                <Button
                  variant="ghost"
                  className="justify-start gap-2 px-2"
                  onClick={() => {
                    setOpen(false);
                    if (organizationProfileMode === "modal") setProfileOpen(true);
                    else navigate(profileUrl);
                  }}
                >
                  <SettingsIcon className="size-4" aria-hidden="true" />
                  {t("organizationSwitcher.action__manageOrganization")}
                </Button>
              ) : null}
              {settings.creationEnabled ? (
                <Button
                  variant="ghost"
                  className="justify-start gap-2 px-2"
                  onClick={() => {
                    setOpen(false);
                    if (createOrganizationMode === "modal") setCreateOpen(true);
                    else navigate(createUrl);
                  }}
                >
                  <PlusIcon className="size-4" aria-hidden="true" />
                  {t("organizationSwitcher.action__createOrganization")}
                </Button>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className={portalClass(OVERLAY_WIDTH.form)}>
          <DialogTitle className="sr-only">{t("createOrganization.title")}</DialogTitle>
          <CreateOrganization
            skipInvitationScreen={skipInvitationScreen}
            afterCreateOrganizationUrl={afterCreateOrganizationUrl}
            onCreated={(created) => {
              setCreateOpen(false);
              void list.memberships.revalidate();
              const url = resolveRedirect(afterCreateOrganizationUrl, created);
              if (url) navigate(fillUrlTemplate(url, { id: created.id, slug: created.slug }));
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className={portalClass("max-h-[85vh] overflow-y-auto sm:max-w-2xl")}>
          <DialogTitle className="sr-only">{t("organizationProfile.navbar.title")}</DialogTitle>
          <OrganizationProfile
            routing="virtual"
            afterLeaveOrganizationUrl={afterLeaveOrganizationUrl}
            onLeaveOrganization={() => setProfileOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
