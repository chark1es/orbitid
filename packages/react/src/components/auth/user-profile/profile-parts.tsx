import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Avatar, AvatarFallback, AvatarImage, Button, Input } from "@orbitid/ui";
import { CameraIcon } from "lucide-react";
import { errorMessage, initials, primaryIdentifier } from "../_shared/api";
import type { TranslateFn } from "../_shared/w6";
import { useAuthRuntime, type OrbitUser } from "../_shared/w6";
import { Field } from "../_shared/field";

export function emailVerificationStatus(resource: { verification?: unknown }): string | null {
  if (typeof resource.verification !== "object" || resource.verification === null) return null;
  const status = Reflect.get(resource.verification, "status");
  return typeof status === "string" ? status : null;
}

export function providerDisplayName(provider: string): string {
  return provider.replace(/^oauth_/, "").replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function messageFor(t: TranslateFn, caught: unknown): string {
  return errorMessage(t, caught);
}

export function ProfileImageEditor({
  user,
  onChanged,
  onError,
}: {
  user: OrbitUser;
  onChanged: () => Promise<void>;
  onError: (caught: unknown) => void;
}) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (file: File | null) => {
    setBusy(true);
    try {
      if (file) await user.setProfileImage?.({ file });
      else if (user.deleteProfileImage) await user.deleteProfileImage();
      else await user.removeProfileImage?.();
      await onChanged();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-4">
      <Avatar className="size-16 border">
        {user.image_url ? <AvatarImage src={user.image_url} alt="" /> : null}
        <AvatarFallback className="text-lg font-semibold">{initials(user)}</AvatarFallback>
      </Avatar>
      <div className="flex flex-wrap gap-2">
        <input
          ref={input}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={t("userProfile.profile.upload")}
          onChange={(event) => {
            const file = event.target.files?.[0] ?? null;
            void upload(file);
            event.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => input.current?.click()}>
          <CameraIcon className="size-4" aria-hidden="true" />
          {t("userProfile.profile.upload")}
        </Button>
        {user.has_image ? (
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void upload(null)}>
            {t("userProfile.profile.removeImage")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ProfileForm({
  user,
  onSaved,
  onError,
}: {
  user: OrbitUser;
  onSaved: () => void;
  onError: (caught: unknown) => void;
}) {
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const form = useForm<{ firstName: string; lastName: string; username: string }>({
    defaultValues: {
      firstName: user.first_name ?? "",
      lastName: user.last_name ?? "",
      username: user.username ?? "",
    },
  });
  const [saving, setSaving] = useState(false);

  const submit = form.handleSubmit(async (values) => {
    // A required attribute cannot be saved blank, whatever it held before.
    const requiredFields = [
      ["firstName", environment.attributes.first_name],
      ["lastName", environment.attributes.last_name],
      ["username", environment.attributes.username],
    ] as const;
    let blank = false;
    for (const [field, attribute] of requiredFields) {
      if (attribute.enabled && attribute.required && !values[field].trim()) {
        form.setError(field, { message: t("formFieldError__required") });
        blank = true;
      }
    }
    if (blank) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};
      if (environment.attributes.first_name.enabled) payload.firstName = values.firstName.trim() || null;
      if (environment.attributes.last_name.enabled) payload.lastName = values.lastName.trim() || null;
      if (environment.attributes.username.enabled && values.username.trim() && values.username.trim() !== user.username) {
        payload.username = values.username.trim();
      }
      if (user.update) await user.update(payload);
      onSaved();
    } catch (caught) {
      onError(caught);
    } finally {
      setSaving(false);
    }
  });

  return (
    <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        {environment.attributes.first_name.enabled ? (
          <Field control={form.control} name="firstName" label={t("formFieldLabel__firstName")} required={environment.attributes.first_name.required}>
            {(field) => <Input {...field} autoComplete="given-name" />}
          </Field>
        ) : null}
        {environment.attributes.last_name.enabled ? (
          <Field control={form.control} name="lastName" label={t("formFieldLabel__lastName")} required={environment.attributes.last_name.required}>
            {(field) => <Input {...field} autoComplete="family-name" />}
          </Field>
        ) : null}
      </div>
      {environment.attributes.username.enabled ? (
        <Field control={form.control} name="username" label={t("formFieldLabel__username")} required={environment.attributes.username.required}>
          {(field) => <Input {...field} autoComplete="username" />}
        </Field>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={saving}>
          {saving ? t("common.saving") : t("userProfile.profile.save")}
        </Button>
        <span className="text-xs text-muted-foreground">{primaryIdentifier(user)}</span>
      </div>
    </form>
  );
}
