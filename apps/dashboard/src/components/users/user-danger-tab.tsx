import { useState } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@orbitid/ui";
import { Trash2, TriangleAlert } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { userLabel } from "../../lib/format";
import { useUserAdmin } from "../../lib/user-admin";
import { ConfirmDialog } from "../shared/confirm-dialog";

export function UserDangerTab({ user, onDeleted }: { user: UserJSON; onDeleted: () => void }) {
  const admin = useUserAdmin(user.id, { onDeleted });
  const [confirm, setConfirm] = useState(false);

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-4" aria-hidden />
          Danger zone
        </CardTitle>
        <CardDescription>
          Deleting a user is permanent: sessions, identifiers, memberships and metadata are removed immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Delete {userLabel(user)}</p>
          <p className="text-xs text-muted-foreground">This account will no longer be able to sign in.</p>
        </div>
        <Button variant="destructive" onClick={() => setConfirm(true)}>
          <Trash2 aria-hidden /> Delete user
        </Button>
      </CardContent>
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
    </Card>
  );
}
