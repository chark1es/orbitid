import { useState } from "react";
import { Button } from "@orbitid/ui";
import { Trash2 } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { userLabel } from "../../lib/format";
import { useUserAdmin } from "../../lib/user-admin";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Panel, Section } from "../shared/section";

export function UserDangerTab({ user, onDeleted }: { user: UserJSON; onDeleted: () => void }) {
  const admin = useUserAdmin(user.id, { onDeleted });
  const [confirm, setConfirm] = useState(false);

  return (
    <Section
      title="Danger zone"
      description="Deleting a user is permanent: sessions, identifiers, memberships and metadata are removed immediately."
      className="border-t-0 pt-0"
    >
      <Panel className="flex flex-wrap items-center justify-between gap-3 border-signal/40 p-4">
        <div className="space-y-1">
          <p className="text-sm font-medium">Delete {userLabel(user)}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            The account can no longer sign in, and its data is removed immediately.
          </p>
        </div>
        <Button variant="destructive" onClick={() => setConfirm(true)}>
          <Trash2 aria-hidden /> Delete user
        </Button>
      </Panel>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this user permanently?"
        description={
          <>
            <span className="font-medium">{userLabel(user)}</span> ({user.id}) will be removed along with every session and
            identifier.
          </>
        }
        confirmLabel="Delete user"
        destructive
        pending={admin.pending === "delete"}
        onConfirm={() => {
          void admin.deleteUser().then((deleted) => {
            if (deleted) onDeleted();
          });
        }}
      />
    </Section>
  );
}
