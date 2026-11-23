import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@orbitid/ui";
import { MailPlusIcon, SearchIcon } from "lucide-react";
import { useLocalizations } from "../../../localization";
import type {
  OrganizationInvitationResource,
  OrganizationMembershipRequestResource,
  OrganizationMembershipResource,
  OrganizationResource,
} from "../../../provider";
import { ConfirmDialog } from "../_shared/ConfirmDialog";
import { EmailChipsInput } from "../_shared/EmailChipsInput";
import { EmptyState, ErrorBanner, LoadingRows, PaginationBar } from "../_shared/Feedback";
import { MemberRow } from "../_shared/MemberRow";
import { OrgAvatar } from "../_shared/OrgAvatar";
import { RoleSelect } from "../_shared/RoleSelect";
import {
  isLastAdminError,
  useAsyncAction,
  useOrgErrorText,
  usePaginatedTable,
  type OrgScope,
} from "../_shared/hooks";
import { formatDate, membershipDisplayName, roleLabel } from "../_shared/utils";
import type { RoleOption } from "../_shared/types";
import { usePortalClass } from "../../auth/_shared/appearance";

export interface MembersSectionProps {
  organization: OrganizationResource;
  scope: OrgScope;
  roles: RoleOption[];
  selfUserId: string | null;
  canManage: boolean;
  memberQuery: string;
  onMemberQueryChange: (query: string) => void;
}

/** Members / invitations / membership-requests tabs of the organization profile. */
export function MembersSection({
  organization,
  scope,
  roles,
  selfUserId,
  canManage,
  memberQuery,
  onMemberQueryChange,
}: MembersSectionProps) {
  const portalClass = usePortalClass();
  const { t } = useLocalizations();
  const { memberships, invitations, membershipRequests, settings } = scope;
  const membersTable = usePaginatedTable(memberships);
  const invitationsTable = usePaginatedTable(invitations);
  const requestsTable = usePaginatedTable(membershipRequests);
  const pendingInvitations = invitationsTable.items.filter(
    (invitation) => invitation.status === "pending",
  );
  const pendingRequests = requestsTable.items.filter((request) => request.status === "pending");
  const [selectedMember, setSelectedMember] = useState<OrganizationMembershipResource | null>(null);
  const [selectedInvitation, setSelectedInvitation] =
    useState<OrganizationInvitationResource | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmails, setInviteEmails] = useState<string[]>([]);
  const [inviteRole, setInviteRole] = useState(settings.defaultRole);
  const [inviteSent, setInviteSent] = useState(false);

  const updateRoleAction = useAsyncAction(
    (membership: OrganizationMembershipResource, role: string) => membership.update({ role }),
  );
  const removeMemberAction = useAsyncAction(async (membership: OrganizationMembershipResource) => {
    await membership.destroy();
    await memberships.revalidate();
    return true;
  });
  const inviteAction = useAsyncAction(async (emails: string[], role: string) => {
    const result = await organization.inviteMembers({ emailAddresses: emails, role });
    await invitations.revalidate();
    return result;
  });
  const revokeAction = useAsyncAction(async (invitation: OrganizationInvitationResource) => {
    await invitation.revoke();
    await invitations.revalidate();
    return true;
  });
  const requestAction = useAsyncAction(
    async (request: OrganizationMembershipRequestResource, action: "accept" | "reject") => {
      if (action === "accept") {
        await request.accept();
        await memberships.revalidate();
      } else {
        await request.reject();
      }
      await membershipRequests.revalidate();
    },
  );

  const roleErrorText = useOrgErrorText(updateRoleAction.error);
  const roleError = isLastAdminError(updateRoleAction.error)
    ? t("organizationProfile.membersSection.lastAdminError")
    : roleErrorText;
  const removeError = useOrgErrorText(removeMemberAction.error);
  const inviteError = useOrgErrorText(inviteAction.error);
  const revokeError = useOrgErrorText(revokeAction.error);
  const requestError = useOrgErrorText(requestAction.error);
  const listError = useOrgErrorText(
    memberships.error ?? invitations.error ?? membershipRequests.error,
  );

  const memberCount = memberQuery.trim()
    ? (organization.membersCount ?? memberships.count)
    : memberships.count;
  const maxMembers = organization.maxAllowedMemberships ?? 0;
  const quota =
    maxMembers > 0
      ? t("organizationProfile.membersSection.memberCount", { count: memberCount, max: maxMembers })
      : t("organizationProfile.membersSection.memberCountUnlimited", { count: memberCount });

  return (
    <Tabs defaultValue="members" className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="members">
          {t("organizationProfile.navbar.members")}
        </TabsTrigger>
        <TabsTrigger value="invitations">
          {t("organizationProfile.invitationsSection.title")}
        </TabsTrigger>
        {settings.membershipRequestsEnabled ? (
          <TabsTrigger value="requests">
            {t("organizationProfile.membershipRequestsSection.title")}
          </TabsTrigger>
        ) : null}
      </TabsList>

      <TabsContent value="members" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="relative w-full max-w-xs">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={memberQuery}
              onChange={(event) => onMemberQueryChange(event.target.value)}
              placeholder={t("organizationProfile.membersSection.searchPlaceholder")}
              aria-label={t("organizationProfile.membersSection.searchPlaceholder")}
              className="pl-8"
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground" data-testid="member-quota">
              {quota}
            </span>
            {canManage ? (
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setInviteSent(false);
                  setInviteOpen(true);
                }}
              >
                <MailPlusIcon aria-hidden="true" />
                {t("organizationProfile.membersSection.inviteButton")}
              </Button>
            ) : null}
          </div>
        </div>

        <ErrorBanner message={roleError} />
        <ErrorBanner message={removeError} />
        <ErrorBanner message={listError} onRetry={() => void memberships.revalidate()} />

        {membersTable.isLoading ? (
          <LoadingRows />
        ) : membersTable.items.length === 0 ? (
          <EmptyState>{t("organizationProfile.membersSection.noMembers")}</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("organizationProfile.membersSection.nameLabel")}</TableHead>
                <TableHead>{t("organizationProfile.membersSection.roleLabel")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("organizationProfile.membersSection.joinedLabel")}
                </TableHead>
                <TableHead className="text-right">
                  {t("organizationProfile.membersSection.actionsLabel")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {membersTable.items.map((membership) => (
                <MemberRow
                  key={membership.id}
                  membership={membership}
                  roles={roles}
                  canManage={canManage}
                  isSelf={membership.publicUserData.userId === selfUserId}
                  busy={updateRoleAction.isPending || removeMemberAction.isPending}
                  onChangeRole={(role) => {
                    if (role === membership.role) return;
                    void updateRoleAction.run(membership, role);
                  }}
                  onRemove={() => setSelectedMember(membership)}
                />
              ))}
            </TableBody>
          </Table>
        )}

        <PaginationBar {...membersTable} />
      </TabsContent>

      <TabsContent value="invitations" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{t("organizationProfile.invitationsSection.title")}</h3>
          {canManage ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setInviteSent(false);
                setInviteOpen(true);
              }}
            >
              <MailPlusIcon aria-hidden="true" />
              {t("organizationProfile.invitationsSection.inviteButton")}
            </Button>
          ) : null}
        </div>
        {inviteSent ? (
          <p className="text-sm text-muted-foreground" role="status">
            {t("organizationProfile.invitationsSection.inviteSuccess")}
          </p>
        ) : null}
        <ErrorBanner message={revokeError} />

        {invitationsTable.isLoading ? (
          <LoadingRows />
        ) : pendingInvitations.length === 0 ? (
          <EmptyState>{t("organizationProfile.invitationsSection.noInvitations")}</EmptyState>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("organizationProfile.invitationsSection.columnEmail")}</TableHead>
                <TableHead>{t("organizationProfile.invitationsSection.roleLabel")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {t("organizationProfile.invitationsSection.columnSent")}
                </TableHead>
                <TableHead className="text-right">
                  {t("organizationProfile.invitationsSection.columnActions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pendingInvitations.map((invitation) => (
                <TableRow key={invitation.id} data-testid={`invitation-row-${invitation.id}`}>
                  <TableCell className="truncate">
                    <span className="block max-w-[32ch] truncate" title={invitation.emailAddress}>
                      {invitation.emailAddress}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {roleLabel(invitation.role, invitation.roleName, t)}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatDate(invitation.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedInvitation(invitation)}
                      >
                        {t("organizationProfile.invitationsSection.action__revoke")}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <PaginationBar {...invitationsTable} />
      </TabsContent>

      {settings.membershipRequestsEnabled ? (
        <TabsContent value="requests" className="flex flex-col gap-3">
          <ErrorBanner message={requestError} />
          {requestsTable.isLoading ? (
            <LoadingRows />
          ) : pendingRequests.length === 0 ? (
            <EmptyState>{t("organizationProfile.membershipRequestsSection.noRequests")}</EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("organizationProfile.membersSection.nameLabel")}</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    {t("organizationProfile.membersSection.joinedLabel")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("organizationProfile.membersSection.actionsLabel")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingRequests.map((request) => {
                  const name = membershipDisplayName(request.publicUserData);
                  return (
                    <TableRow key={request.id} data-testid={`request-row-${request.id}`}>
                      <TableCell>
                        <div className="flex min-w-0 items-center gap-2">
                          <OrgAvatar
                            name={name}
                            imageUrl={request.publicUserData.imageUrl}
                            hasImage={request.publicUserData.hasImage}
                          />
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate font-medium">{name}</span>
                            <span className="truncate text-muted-foreground">
                              {request.publicUserData.identifier}
                            </span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {formatDate(request.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            size="xs"
                            disabled={requestAction.isPending}
                            onClick={() => void requestAction.run(request, "accept")}
                          >
                            {t("organizationProfile.membershipRequestsSection.accept")}
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={requestAction.isPending}
                            onClick={() => void requestAction.run(request, "reject")}
                          >
                            {t("organizationProfile.membershipRequestsSection.reject")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <PaginationBar {...requestsTable} />
        </TabsContent>
      ) : null}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className={portalClass("sm:max-w-md")}>
          <DialogHeader>
            <DialogTitle>{t("organizationProfile.invitationsSection.inviteTitle")}</DialogTitle>
            <DialogDescription>
              {t("organizationProfile.invitationsSection.inviteSubtitle")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <EmailChipsInput
              label={t("formFieldLabel__emailAddresses")}
              placeholder={t("formFieldInputPlaceholder__emailAddresses")}
              value={inviteEmails}
              onChange={setInviteEmails}
              disabled={inviteAction.isPending}
            />
            <RoleSelect
              label={t("organizationProfile.invitationsSection.roleLabel")}
              roles={roles}
              value={inviteRole}
              onChange={setInviteRole}
              size="default"
            />
            <ErrorBanner message={inviteError} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setInviteOpen(false)}>
              {t("formButtonReset")}
            </Button>
            <Button
              type="button"
              disabled={inviteAction.isPending || inviteEmails.length === 0}
              onClick={() => {
                void inviteAction.run(inviteEmails, inviteRole).then((result) => {
                  if (result === undefined) return;
                  setInviteEmails([]);
                  setInviteOpen(false);
                  setInviteSent(true);
                });
              }}
            >
              {inviteAction.isPending
                ? t("status.loading")
                : t("organizationProfile.invitationsSection.inviteButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={selectedMember !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedMember(null);
        }}
        title={t("organizationProfile.membersSection.removeMemberTitle")}
        description={t("organizationProfile.membersSection.removeMemberSubtitle")}
        confirmLabel={t("organizationProfile.membersSection.action__removeMember")}
        destructive
        error={removeError}
        onConfirm={async () => {
          if (!selectedMember) return;
          const removed = await removeMemberAction.run(selectedMember);
          if (removed) setSelectedMember(null);
        }}
      >
        {selectedMember ? (
          <p className="text-sm text-muted-foreground">
            {membershipDisplayName(selectedMember.publicUserData)}
          </p>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={selectedInvitation !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedInvitation(null);
        }}
        title={t("organizationProfile.invitationsSection.revokeTitle")}
        description={t("organizationProfile.invitationsSection.revokeSubtitle", {
          email: selectedInvitation?.emailAddress ?? "",
        })}
        confirmLabel={t("organizationProfile.invitationsSection.action__revoke")}
        destructive
        error={revokeError}
        onConfirm={async () => {
          if (!selectedInvitation) return;
          const revoked = await revokeAction.run(selectedInvitation);
          if (revoked) setSelectedInvitation(null);
        }}
      />
    </Tabs>
  );
}
