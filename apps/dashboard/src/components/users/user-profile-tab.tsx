import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button, Input, Label } from "@orbitid/ui";
import { ImagePlus, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { UserJSON } from "@orbitid/shared";
import { useApiMutation } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { uploadProfileImage } from "../../lib/uploads";
import { CopyButton } from "../shared/copy-button";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Panel, Section } from "../shared/section";
import { UserAvatar } from "../shared/user-avatar";
import { userLabel } from "../../lib/format";
import { useInstance } from "../../lib/instance";
import { REQUIRED_FIELD_LABELS, missingRequiredFields, requiredUserFields } from "../../lib/users";

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

  const instance = useInstance();
  const required = requiredUserFields(instance.data);
  // Email and phone are managed on the Identifiers tab; only the fields this form edits can be missing here.
  const editable = new Set([...required].filter((field) => field === "firstName" || field === "lastName" || field === "username"));
  const missing = missingRequiredFields({ firstName, lastName, username }, editable);

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
    <Section
      title="Profile"
      description="Names and the external ID are visible wherever the user is rendered."
      className="border-t-0 pt-0"
    >
      <div className="grid gap-5 lg:grid-cols-3">
        <Panel className="p-4 lg:col-span-2">
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!instance.data || missing.length > 0) return;
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
                <Label htmlFor="profile-first-name">First name{required.has("firstName") ? <span className="text-muted-foreground"> (required)</span> : null}</Label>
                <Input
                  id="profile-first-name"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  aria-required={required.has("firstName") || undefined}
                  aria-invalid={missing.includes("firstName") || undefined}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-last-name">Last name{required.has("lastName") ? <span className="text-muted-foreground"> (required)</span> : null}</Label>
                <Input
                  id="profile-last-name"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  aria-required={required.has("lastName") || undefined}
                  aria-invalid={missing.includes("lastName") || undefined}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-username">Username{required.has("username") ? <span className="text-muted-foreground"> (required)</span> : null}</Label>
                <Input
                  id="profile-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  aria-required={required.has("username") || undefined}
                  aria-invalid={missing.includes("username") || undefined}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="profile-external-id">External ID</Label>
                <Input id="profile-external-id" value={externalId} onChange={(event) => setExternalId(event.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>User ID</Label>
              <div className="flex items-center gap-1">
                <code className="rounded-[3px] border border-border bg-muted px-2 py-1 font-data text-xs">{user.id}</code>
                <CopyButton value={user.id} label="Copy user ID" />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
              {missing.length > 0 ? (
                <p role="alert" className="mr-auto text-[0.8125rem] leading-relaxed text-signal">
                  {missing.map((field) => REQUIRED_FIELD_LABELS[field]).join(", ")} {missing.length === 1 ? "is" : "are"} required by this
                  instance's settings.
                </p>
              ) : null}
              {instance.error ? <p role="alert" className="mr-auto text-sm text-signal">Required field settings could not be loaded. <Button type="button" variant="outline" size="sm" onClick={() => void instance.refetch()}>Retry</Button></p> : null}
              <Button type="submit" disabled={!instance.data || !dirty || save.isPending || missing.length > 0}>
                {save.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Save profile
              </Button>
            </div>
          </form>
        </Panel>

        <Panel className="flex flex-col gap-4 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Avatar</h3>
            <p className="text-xs leading-5 text-muted-foreground">PNG, JPEG, GIF or WebP. Stored on this instance.</p>
          </div>
          <div className="flex flex-col items-center gap-4 py-2">
            <UserAvatar name={userLabel(user)} imageUrl={user.image_url} size="lg" className="size-20" />
            <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={onFileChange} />
            <div className="flex w-full flex-col gap-2">
              <Button
                type="button"
                size="sm"
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
                size="sm"
                variant="ghost"
                className="w-full text-signal hover:text-signal"
                disabled={!user.has_image || removeImage.isPending}
                onClick={() => setConfirmRemoveImage(true)}
              >
                <Trash2 aria-hidden /> Remove image
              </Button>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              Removing the image falls back to a generated avatar.
            </p>
          </div>
          <dl className="space-y-1 border-t border-border pt-3 font-data text-xs leading-5 text-muted-foreground">
            <div>
              <dt className="inline">Created </dt>
              <dd className="inline">{new Date(user.created_at).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="inline">Updated </dt>
              <dd className="inline">{new Date(user.updated_at).toLocaleString()}</dd>
            </div>
          </dl>
        </Panel>
      </div>

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
    </Section>
  );
}
