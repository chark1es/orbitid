import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { UserJSON } from "@orbitid/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  buttonVariants,
} from "@orbitid/ui";
import {
  Ban,
  CircleCheck,
  Copy,
  Eye,
  Lock,
  LogOut,
  MoreHorizontal,
  Trash2,
  Unlock,
} from "lucide-react";
import { toast } from "sonner";
import { useCopyToClipboard } from "../../lib/hooks";
import { userLabel } from "../../lib/format";
import { useUserAdmin } from "../../lib/user-admin";
import { ConfirmDialog } from "../shared/confirm-dialog";

export function UserRowActions({ user, onDeleted }: { user: UserJSON; onDeleted?: () => void }) {
  const navigate = useNavigate();
  const admin = useUserAdmin(user.id, { onDeleted });
  const copy = useCopyToClipboard();
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div onClick={(event) => event.stopPropagation()}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={buttonVariants({ variant: "ghost", size: "icon" })}
            aria-label={`Actions for ${userLabel(user)}`}
          >
            <MoreHorizontal aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 rounded-[4px] border-border">
          <DropdownMenuItem onSelect={() => navigate(`/users/${user.id}`)}>
            <Eye aria-hidden /> View details
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={async () => {
              if (await copy(user.id)) toast.success("User ID copied");
            }}
          >
            <Copy aria-hidden /> Copy user ID
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {user.banned ? (
            <DropdownMenuItem onSelect={() => void admin.unban()} disabled={admin.pending === "unban"}>
              <CircleCheck aria-hidden /> Unban user
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void admin.ban()} disabled={admin.pending === "ban"}>
              <Ban aria-hidden /> Ban user
            </DropdownMenuItem>
          )}
          {user.locked ? (
            <DropdownMenuItem onSelect={() => void admin.unlock()} disabled={admin.pending === "unlock"}>
              <Unlock aria-hidden /> Unlock user
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={() => void admin.lock()} disabled={admin.pending === "lock"}>
              <Lock aria-hidden /> Lock user
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => void admin.revokeSessions()} disabled={admin.pending === "revoke-sessions"}>
            <LogOut aria-hidden /> Sign out everywhere
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-signal focus:text-signal"
            onSelect={(event) => {
              event.preventDefault();
              setConfirmDelete(true);
            }}
          >
            <Trash2 aria-hidden /> Delete user…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this user?"
        description={
          <>
            <span className="font-medium">{userLabel(user)}</span> and all of their sessions, identifiers and memberships
            will be permanently removed. This cannot be undone.
          </>
        }
        confirmLabel="Delete user"
        destructive
        pending={admin.pending === "delete"}
        onConfirm={() => {
          void admin.deleteUser().then((deleted) => {
            if (deleted) setConfirmDelete(false);
          });
        }}
      />
    </div>
  );
}
