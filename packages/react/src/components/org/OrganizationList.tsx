import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Separator,
  OVERLAY_WIDTH,
} from "@orbitid/ui";
import { CheckIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useLocalizations } from "../../localization";
import { useOrbitID } from "../../hooks";
import type { OrganizationResource, UserResource } from "../../provider";
import { acceptOrganizationInvitation } from "./_shared/fapi";
import { EmptyState, ErrorBanner } from "./_shared/Feedback";
import { OrgAvatar } from "./_shared/OrgAvatar";
import { OrgRoot } from "./_shared/OrgRoot";
import { CreateOrganization } from "./CreateOrganization";
import {
  useAsyncAction,
  useNavigate,
  useOrgErrorText,
  useOrgSettings,
  useSelfUser,
  useUserOrgScope,
} from "./_shared/hooks";
import { fillUrlTemplate, resolveRedirect, roleLabel } from "./_shared/utils";
import type { CommonOrgProps, RedirectUrl } from "./_shared/types";
import { usePortalClass } from "../auth/_shared/appearance";

export interface OrganizationListProps extends CommonOrgProps {
  hidePersonal?: boolean;
  afterCreateOrganizationUrl?: RedirectUrl<OrganizationResource>;
  afterSelectOrganizationUrl?: RedirectUrl<OrganizationResource>;
  afterSelectPersonalUrl?: RedirectUrl<UserResource | null>;
  skipInvitationScreen?: boolean;
}

/** Full-page organization picker with invitations, suggestions, personal account and creation. */
export function OrganizationList(props: OrganizationListProps) {
  return (
    <OrgRoot appearance={props.appearance} className={props.className}>
      <OrganizationListView {...props} />
    </OrgRoot>
  );
}

function OrganizationListView({
  hidePersonal,
  afterCreateOrganizationUrl,
  afterSelectOrganizationUrl,
  afterSelectPersonalUrl,
  skipInvitationScreen,
}: OrganizationListProps) {
  const portalClass = usePortalClass();
  const { t } = useLocalizations();
  const instance = useOrbitID();
  const navigate = useNavigate();
  const settings = useOrgSettings();
  const self = useSelfUser();
  const list = useUserOrgScope();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [invitationsDismissed, setInvitationsDismissed] = useState(Boolean(skipInvitationScreen));

  const selectAction = useAsyncAction(async (next: OrganizationResource | null) => {
    await list.setActive({ organization: next });
    return true;
  });
  const acceptAction = useAsyncAction(async (invitationId: string, organizationId?: string) => {
    await acceptOrganizationInvitation(instance, { id: invitationId });
    await Promise.all([list.invitations.revalidate(), list.memberships.revalidate()]);
    if (organizationId) await list.setActive({ organization: organizationId });
    return organizationId ?? null;
  });

  const redirectAfterAccept = async (organizationId?: string | null) => {
    if (!organizationId || !afterSelectOrganizationUrl) return;
    const organization = await instance.getOrganization(organizationId).catch(() => null);
    if (!organization) return;
    const url = resolveRedirect(afterSelectOrganizationUrl, organization);
    if (url) navigate(fillUrlTemplate(url, { id: organization.id, slug: organization.slug }));
  };
  const suggestionAction = useAsyncAction(
    async (suggestion: { accept(): Promise<unknown>; publicOrganizationData: { id: string } }) => {
      await suggestion.accept();
      await list.memberships.revalidate();
      await list.setActive({ organization: suggestion.publicOrganizationData.id });
      return suggestion.publicOrganizationData.id;
    },
  );
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

  const showInvitationStep = !invitationsDismissed && list.invitations.data.length > 0;

  const select = async (next: OrganizationResource | null) => {
    const ok = await selectAction.run(next);
    if (!ok) return;
    const url = next
      ? resolveRedirect(afterSelectOrganizationUrl, next)
      : resolveRedirect(afterSelectPersonalUrl, self.user);
    if (url) navigate(fillUrlTemplate(url, { id: next?.id, slug: next?.slug }));
  };

  if (!list.isLoaded) {
    return <p className="text-sm text-muted-foreground">{t("status.loading")}</p>;
  }

  if (showInvitationStep) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{t("organizationList.invitationsTitle")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("organizationList.invitationsSubtitle")}
          </p>
        </header>
        <ErrorBanner message={error ?? listError} />
        <div className="flex flex-col gap-2">
          {list.invitations.data.map((invitation) => {
            const organizationName =
              invitation.organizationName ?? invitation.organization?.name ?? null;
            const organizationImage =
              invitation.organizationImageUrl ?? invitation.organization?.imageUrl ?? null;
            return (
              <div
                key={invitation.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                data-testid={`org-list-invitation-${invitation.id}`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {organizationName ? (
                    <OrgAvatar name={organizationName} imageUrl={organizationImage} />
                  ) : null}
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {organizationName ?? invitation.emailAddress}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">
                      {roleLabel(invitation.role, invitation.roleName, t)}
                    </span>
                    {organizationName ? (
                      <span className="truncate text-sm text-muted-foreground">
                        {invitation.emailAddress}
                      </span>
                    ) : null}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  disabled={acceptAction.isPending}
                  onClick={() => {
                    void acceptAction
                      .run(invitation.id, invitation.organizationId)
                      .then(redirectAfterAccept);
                  }}
                >
                  {t("organizationList.invitationAccept")}
                </Button>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => setInvitationsDismissed(true)}
          >
            {t("organizationList.skipInvitations")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">
          {hidePersonal ? t("organizationList.titleWithoutPersonal") : t("organizationList.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {hidePersonal
            ? t("organizationList.subtitleWithoutPersonal")
            : t("organizationList.subtitle")}
        </p>
      </header>

      <ErrorBanner message={error ?? listError} />

      <div className="relative">
        <SearchIcon
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("organizationList.searchPlaceholder")}
          aria-label={t("organizationList.searchPlaceholder")}
          className="pl-8"
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
        {memberships.map((item) => (
          <Button
            key={item.id}
            type="button"
            variant="outline"
            disabled={selectAction.isPending}
            onClick={() => void select(item.organization)}
            className="h-auto w-full min-w-0 max-w-full items-center justify-start gap-3 p-3 text-left font-normal"
            data-testid={`org-list-membership-${item.organization.id}`}
          >
            <OrgAvatar
              name={item.organization.name}
              imageUrl={item.organization.imageUrl}
              hasImage={item.organization.hasImage}
              size="md"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{item.organization.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {item.organization.slug}
                {typeof item.organization.membersCount === "number"
                  ? ` · ${t("organizationList.memberCount", {
                      count: item.organization.membersCount,
                    })}`
                  : ""}
              </span>
            </span>
            <Badge variant="secondary">{roleLabel(item.role, item.roleName, t)}</Badge>
          </Button>
        ))}

        {!hidePersonal && !settings.forceOrganizationSelection ? (
          <Button
            type="button"
            variant="outline"
            disabled={selectAction.isPending}
            onClick={() => void select(null)}
            className="h-auto w-full min-w-0 max-w-full items-center justify-start gap-3 p-3 text-left font-normal"
          >
            <OrgAvatar name={self.name || t("organizationSwitcher.personalWorkspace")} size="md" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">
                {t("organizationSwitcher.personalWorkspace")}
              </span>
              <span className="truncate text-xs text-muted-foreground">{self.name}</span>
            </span>
            <CheckIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          </Button>
        ) : null}

        {settings.creationEnabled ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => setCreateOpen(true)}
            className="h-auto w-full min-w-0 max-w-full items-center justify-start gap-3 border-dashed p-3 text-left font-normal"
          >
            <span className="flex size-10 items-center justify-center rounded-md bg-muted">
              <PlusIcon className="size-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 truncate font-medium">{t("organizationList.action__createOrganization")}</span>
          </Button>
        ) : null}
      </div>

      {memberships.length === 0 && !query.trim() ? (
        <EmptyState>{t("organizationList.noOrganizations")}</EmptyState>
      ) : memberships.length === 0 ? (
        <EmptyState>{t("organizationList.notFound")}</EmptyState>
      ) : null}

      {list.suggestions.data.length > 0 ? (
        <>
          <Separator />
          <section className="flex flex-col gap-2" aria-label={t("organizationList.suggestionsTitle")}>
            <h3 className="text-sm font-medium text-muted-foreground">
              {t("organizationList.suggestionsTitle")}
            </h3>
            {list.suggestions.data.map((suggestion) => (
              <div
                key={suggestion.id}
                className="flex items-center justify-between gap-2 rounded-lg border p-3"
                data-testid={`org-list-suggestion-${suggestion.id}`}
              >
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <OrgAvatar
                    name={suggestion.publicOrganizationData.name}
                    imageUrl={suggestion.publicOrganizationData.imageUrl}
                    hasImage={suggestion.publicOrganizationData.hasImage}
                  />
                  <span className="truncate font-medium">
                    {suggestion.publicOrganizationData.name}
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={suggestionAction.isPending}
                  onClick={() => {
                    void suggestionAction.run(suggestion);
                  }}
                >
                  {t("organizationList.suggestionJoin")}
                </Button>
              </div>
            ))}
          </section>
        </>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className={portalClass(OVERLAY_WIDTH.form)}>
          <DialogTitle className="sr-only">{t("createOrganization.title")}</DialogTitle>
          <CreateOrganization
            afterCreateOrganizationUrl={afterCreateOrganizationUrl}
            skipInvitationScreen={skipInvitationScreen}
            onCreated={(created) => {
              setCreateOpen(false);
              void list.memberships.revalidate();
              const url = resolveRedirect(afterCreateOrganizationUrl, created);
              if (url) navigate(fillUrlTemplate(url, { id: created.id, slug: created.slug }));
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
