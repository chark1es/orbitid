import { useState, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
} from "@orbitid/ui";
import { Loader2 } from "lucide-react";
import { useApiMutation } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { parseJsonObject } from "../../lib/format";
import { buildCreateUserPayload, emptyCreateUserForm, type CreateUserForm } from "../../lib/users";
import { JsonEditor } from "../shared/json-editor";

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState<CreateUserForm>(emptyCreateUserForm);
  const [error, setError] = useState<string | null>(null);
  const mutation = useApiMutation("POST", "/users", { invalidate: [["users"], ["stats"]] });

  const set = <K extends keyof CreateUserForm>(key: K) => (value: CreateUserForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const metadataInvalid = [form.publicMetadata, form.privateMetadata, form.unsafeMetadata].some(
    (text) => text.trim() !== "" && !parseJsonObject(text).ok,
  );

  function close(next: boolean) {
    if (!next) {
      setForm(emptyCreateUserForm());
      setError(null);
    }
    onOpenChange(next);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!form.email.trim() && !form.phone.trim() && !form.username.trim()) {
      setError("Provide at least one identifier: email, phone number or username.");
      return;
    }
    let payload;
    try {
      payload = buildCreateUserPayload(form);
    } catch (cause) {
      setError(errorMessage(cause));
      return;
    }
    mutation.mutate(payload, {
      onSuccess: () => close(false),
      onError: (cause) => setError(errorMessage(cause)),
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create user</DialogTitle>
          <DialogDescription>
            Creates a user through the Backend API. Passwords are checked against the instance policy unless skipped.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="create-email">Email address</Label>
              <Input
                id="create-email"
                type="email"
                value={form.email}
                onChange={(event) => set("email")(event.target.value)}
                placeholder="ada@example.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-phone">Phone number</Label>
              <Input
                id="create-phone"
                value={form.phone}
                onChange={(event) => set("phone")(event.target.value)}
                placeholder="+15551234567"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-username">Username</Label>
              <Input
                id="create-username"
                value={form.username}
                onChange={(event) => set("username")(event.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-password">Password</Label>
              <Input
                id="create-password"
                type="password"
                value={form.password}
                onChange={(event) => set("password")(event.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-first-name">First name</Label>
              <Input id="create-first-name" value={form.firstName} onChange={(event) => set("firstName")(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-last-name">Last name</Label>
              <Input id="create-last-name" value={form.lastName} onChange={(event) => set("lastName")(event.target.value)} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="create-external-id">External ID</Label>
              <Input
                id="create-external-id"
                value={form.externalId}
                onChange={(event) => set("externalId")(event.target.value)}
                placeholder="Your system's user id"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-[4px] border border-border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="create-skip-checks">Skip password checks</Label>
              <p className="text-xs text-muted-foreground">Bypass length, complexity and pwned-password validation.</p>
            </div>
            <Switch id="create-skip-checks" checked={form.skipPasswordChecks} onCheckedChange={set("skipPasswordChecks")} />
          </div>

          <div className="border-t border-border" />

          <div className="space-y-4">
            <JsonEditor
              id="create-public-metadata"
              label="Public metadata"
              description="Readable from the Frontend API and included in the session token."
              value={form.publicMetadata}
              onChange={set("publicMetadata")}
              rows={4}
            />
            <JsonEditor
              id="create-private-metadata"
              label="Private metadata"
              description="Backend API only."
              value={form.privateMetadata}
              onChange={set("privateMetadata")}
              rows={4}
            />
            <JsonEditor
              id="create-unsafe-metadata"
              label="Unsafe metadata"
              description="Writable by the user from the client SDK."
              value={form.unsafeMetadata}
              onChange={set("unsafeMetadata")}
              rows={4}
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-[4px] border border-signal/40 bg-signal/5 px-3 py-2 text-sm text-signal">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => close(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || metadataInvalid}>
              {mutation.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Create user
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
