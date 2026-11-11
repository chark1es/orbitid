import { Badge, Button, TableCell, TableRow } from "@orbitid/ui";
import { Trash2Icon } from "lucide-react";
import { RoleSelect } from "./RoleSelect";
import { OrgAvatar } from "./OrgAvatar";
import { useLocalizations } from "../../../localization";
import type { OrganizationMembershipResource } from "../../../provider";
import type { RoleOption } from "./types";
import { formatDate, membershipDisplayName, roleLabel } from "./utils";

export interface MemberRowProps {
  membership: OrganizationMembershipResource;
  roles: RoleOption[];
  /** Whether the caller may change roles/remove members. */
  canManage: boolean;
  /** True for the signed-in user's own row. */
  isSelf?: boolean;
  /** Disables the row's controls while a mutation runs. */
  busy?: boolean;
  onChangeRole: (role: string) => void;
  onRemove: () => void;
}

/** One member row: avatar, name, email, role control and remove action. */
export function MemberRow({
  membership,
  roles,
  canManage,
  isSelf,
  busy,
  onChangeRole,
  onRemove,
}: MemberRowProps) {
  const { t } = useLocalizations();
  const name = membershipDisplayName(membership.publicUserData);
  const email = membership.publicUserData.identifier;
  return (
    <TableRow data-testid={`member-row-${membership.id}`}>
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          <OrgAvatar
            name={name}
            imageUrl={membership.publicUserData.imageUrl}
            hasImage={membership.publicUserData.hasImage}
          />
          <div className="flex min-w-0 flex-col">
            <span className="flex items-center gap-1.5 truncate font-medium">
              <span className="truncate">{name}</span>
              {isSelf ? (
                <Badge variant="outline" className="shrink-0">
                  {t("badge__you")}
                </Badge>
              ) : null}
            </span>
            <span className="block max-w-[32ch] truncate text-muted-foreground" title={email}>{email}</span>
          </div>
        </div>
      </TableCell>
      <TableCell>
        {canManage ? (
          <RoleSelect
            roles={roles}
            value={membership.role}
            disabled={busy}
            ariaLabel={t("organizationProfile.membersSection.action__changeRole")}
            onChange={onChangeRole}
          />
        ) : (
          <Badge variant="secondary">{roleLabel(membership.role, membership.roleName, t)}</Badge>
        )}
      </TableCell>
      <TableCell className="hidden text-muted-foreground sm:table-cell">
        {formatDate(membership.createdAt)}
      </TableCell>
      <TableCell className="text-right">
        {canManage && !isSelf ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={`${t("organizationProfile.membersSection.action__removeMember")} ${name}`}
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden="true" />
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
