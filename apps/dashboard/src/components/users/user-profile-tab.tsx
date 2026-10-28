import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Separator,
} from "@orbitid/ui";
import { ImagePlus, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { UserJSON } from "@orbitid/shared";
import { useApiMutation } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { uploadProfileImage } from "../../lib/uploads";
import { CopyButton } from "../shared/copy-button";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { UserAvatar } from "../shared/user-avatar";
import { userLabel } from "../../lib/format";

export function UserProfileTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const [firstName, setFirstName] = useState(user.first_name ?? "");
  const [lastName, setLastName] = useState(user.last_name ?? "");
  const [username, setUsername] = useState(user.username ?? "");
  const [externalId, setExternalId] = useState(user.external_id ?? "");
  const [confirmRemoveImage, setConfirmRemoveImage] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setFirstName(user.first_name ?? "");
    setLastName(user.last_name ?? "");
    setUsername(user.username ?? "");
    setExternalId(user.external_id ?? "");
  }, [user]);

  const save = useApiMutation<Record<string, unknown>>("PATCH", `/users/${user.id}`, {
    invalidate: [["user", user.id], ["users"]],
    onSuccess: () => toast.success("Profile updated"),
  });

  const removeImage = useApiMutation<undefined, unknown>("DELETE", `/users/${user.id}/profile_image`, {
    invalidate: [["user", user.id], ["users"]],
    onSuccess: () => {
      toast.success("Profile image removed");
      setConfirmRemoveImage(false);
    },
  });

  const dirty =
    firstName !== (user.first_name ?? "") ||
    lastName !== (user.last_name ?? "") ||
    username !== (user.username ?? "") ||
    externalId !== (user.external_id ?? "");

  async function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      await uploadProfileImage(user.id, file);
      toast.success("Profile image updated");
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>Names and the external ID are visible wherever the user is rendered.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              const body: Record<string, unknown> = {
                first_name: firstName.trim() || null,
                last_name: lastName.trim() || null,
                username: username.trim() || null,
                external_id: externalId.trim() || null,
              };
              save.mutate(body, { onError: (error) => toast.error(errorMessage(error)) });
            }}
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="profile-first-name">First name</Label>
                <Input id="profile-first-name" value={firstName} onChange={(event) => setFirstName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-last-name">Last name</Label>
                <Input id="profile-last-name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-username">Username</Label>
                <Input id="profile-username" value={username} onChange={(event) => setUsername(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-external-id">External ID</Label>
                <Input id="profile-external-id" value={externalId} onChange={(event) => setExternalId(event.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>User ID</Label>
              <div className="flex items-center gap-1">
                <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{user.id}</code>
                <CopyButton value={user.id} label="Copy user ID" />
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={!dirty || save.isPending}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Save profile
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Avatar</CardTitle>
          <CardDescription>PNG, JPEG, GIF or WebP. Uploaded to the instance.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="lg" className="size-20" />
          <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
          <div className="flex w-full flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
              className="w-full"
            >
              {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <ImagePlus aria-hidden />}
              {uploading ? "Uploading…" : "Upload image"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full text-destructive hover:text-destructive"
              disabled={!user.has_image || removeImage.isPending}
              onClick={() => setConfirmRemoveImage(true)}
            >
              <Trash2 aria-hidden /> Remove image
            </Button>
          </div>
        </CardContent>
        <Separator />
        <CardContent className="pt-4 text-xs text-muted-foreground">
          Created {new Date(user.created_at).toLocaleString()} · Updated {new Date(user.updated_at).toLocaleString()}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmRemoveImage}
        onOpenChange={setConfirmRemoveImage}
        title="Remove profile image?"
        description="The user falls back to a generated avatar."
        confirmLabel="Remove image"
        destructive
        pending={removeImage.isPending}
        onConfirm={() =>
          removeImage.mutate(undefined, { onError: (error) => toast.error(errorMessage(error)) })
        }
      />
    </div>
  );
}
