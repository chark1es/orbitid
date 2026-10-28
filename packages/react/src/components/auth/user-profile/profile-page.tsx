import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Separator,
  Textarea,
  cn,
} from "@orbitid/ui";
import { CameraIcon, LinkIcon, MailIcon, PhoneIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
  attemptEmailVerification,
  attemptPhoneVerification,
  currentUser,
  errorMessage,
  findEmail,
  findPhone,
  initials,
  prepareEmailVerification,
  preparePhoneVerification,
  primaryIdentifier,
  reloadOrbit,
} from "../_shared/api";
import { useElementClasses } from "../_shared/appearance";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { FormError } from "../_shared/form-error";
import { OtpField } from "../_shared/otp-field";
import { PhoneInput } from "../_shared/phone-input";
import { normalizePhone } from "../_shared/normalize";
import { ProviderIcon } from "../_shared/provider-icon";
import { useReverification } from "../../../hooks";
import type { TranslateFn } from "../_shared/w6";
import { useAuthRuntime, type EmailAddressResource, type ExternalAccountResource, type OrbitUser, type PhoneNumberResource } from "../_shared/w6";
import { Field } from "../_shared/field";

interface PageProps {
  onNavigate: (page: string) => void;
}

export function ProfilePage({ onNavigate }: PageProps) {
  const runtime = useAuthRuntime();
  const { orbit, t, environment } = runtime;
  const { el } = useElementClasses();
  const user = currentUser(orbit);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [emailDialog, setEmailDialog] = useState<{ open: boolean; email?: EmailAddressResource }>({ open: false });
  const [phoneDialog, setPhoneDialog] = useState<{ open: boolean; phone?: PhoneNumberResource }>({ open: false });
  const [removeTarget, setRemoveTarget] = useState<
    { kind: "email" | "phone"; id: string; identifier: string } | null
  >(null);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ExternalAccountResource | null>(null);
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());

  const refresh = async () => {
    await reloadOrbit(orbit);
    runtime.refresh();
  };

  const runAction = async (action: () => Promise<unknown>, success?: string) => {
    setError(null);
    setNotice(null);
    try {
      await withVerification(action);
      await refresh();
      if (success) setNotice(success);
    } catch (caught) {
      setError(messageFor(t, caught));
    }
  };

  if (!user) {
    return <p className="text-sm text-muted-foreground">{t("userProfile.profile.noUser")}</p>;
  }

  const emails = user.email_addresses ?? [];
  const phones = user.phone_numbers ?? [];
  const external_accounts = user.external_accounts ?? [];
  const connectedProviders = new Set(external_accounts.map((account) => account.provider.replace(/^oauth_/, "")));
  const availableProviders = environment.social.filter((provider) => !connectedProviders.has(provider.id));

  return (
    <div className="flex flex-col gap-6">
      <FormError message={error} />
      {notice ? (
        <p role="status" className="rounded-md border border-emerald-600/20 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}

      <section className={cn("flex flex-col gap-4", el("profileSection"))} data-orbit-section="profile">
        <div>
          <h2 className={cn("text-sm font-semibold", el("profileSectionTitle"))}>{t("userProfile.profile.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("userProfile.profile.description")}</p>
        </div>
        <ProfileImageEditor user={user} onChanged={refresh} onError={(caught) => setError(messageFor(t, caught))} />
        <Separator />
        <ProfileForm user={user} onSaved={() => void runAction(async () => undefined, t("userProfile.profile.saved"))} onError={(caught) => setError(messageFor(t, caught))} />
      </section>

      <Separator />

      <section className="flex flex-col gap-3" data-orbit-section="emails">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{t("userProfile.emailAddresses.title")}</h2>
            <p className="text-xs text-muted-foreground">{t("userProfile.emailAddresses.description")}</p>
          </div>
          <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setEmailDialog({ open: true })}>
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("userProfile.emailAddresses.add")}
          </Button>
        </div>
        <ul className="flex flex-col divide-y rounded-md border">
          {emails.map((email) => {
            const verified = emailVerificationStatus(email) === "verified";
            const isPrimary = user.primary_email_address_id === email.id;
            return (
              <li key={email.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5" data-testid={`email-${email.email_address}`}>
                <MailIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm">{email.email_address}</span>
                {isPrimary ? <Badge variant="secondary">{t("common.primary")}</Badge> : null}
                <Badge variant={verified ? "outline" : "destructive"}>
                  {verified ? t("userProfile.emailAddresses.verified") : t("userProfile.emailAddresses.unverified")}
                </Badge>
                {!verified ? (
                  <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setEmailDialog({ open: true, email })}>
                    {t("common.verify")}
                  </Button>
                ) : null}
                {!isPrimary && verified ? (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => void runAction(() => user.update?.({ primaryEmailAddressId: email.id }) ?? Promise.resolve())}
                  >
                    {t("userProfile.emailAddresses.setPrimary")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={t("userProfile.emailAddresses.remove")}
                  disabled={emails.length <= 1}
                  onClick={() => setRemoveTarget({ kind: "email", id: email.id, identifier: email.email_address })}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-3" data-orbit-section="phones">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{t("userProfile.phoneNumbers.title")}</h2>
            <p className="text-xs text-muted-foreground">{t("userProfile.phoneNumbers.description")}</p>
          </div>
          {environment.attributes.phone_number.enabled ? (
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setPhoneDialog({ open: true })}>
              <PlusIcon className="size-4" aria-hidden="true" />
              {t("userProfile.phoneNumbers.add")}
            </Button>
          ) : null}
        </div>
        {phones.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("userProfile.mfaPhones.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {phones.map((phone) => {
              const verified = emailVerificationStatus(phone) === "verified";
              const isPrimary = user.primary_phone_number_id === phone.id;
              return (
                <li key={phone.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                  <PhoneIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm">{phone.phone_number}</span>
                  {isPrimary ? <Badge variant="secondary">{t("common.primary")}</Badge> : null}
                  {phone.reserved_for_second_factor ? <Badge variant="outline">{t("userProfile.mfaPhones.default")}</Badge> : null}
                  {!verified ? (
                    <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => setPhoneDialog({ open: true, phone })}>
                      {t("common.verify")}
                    </Button>
                  ) : null}
                  {!isPrimary && verified ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      onClick={() => void runAction(() => user.update?.({ primaryPhoneNumberId: phone.id }) ?? Promise.resolve())}
                    >
                      {t("userProfile.phoneNumbers.setPrimary")}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground"
                    aria-label={t("userProfile.phoneNumbers.remove")}
                    onClick={() => setRemoveTarget({ kind: "phone", id: phone.id, identifier: phone.phone_number })}
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3" data-orbit-section="connected-accounts">
        <div>
          <h2 className="text-sm font-semibold">{t("userProfile.connectedAccounts.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("userProfile.connectedAccounts.description")}</p>
        </div>
        {external_accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("userProfile.connectedAccounts.none")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {external_accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <ProviderIcon provider={account.provider} className="size-5" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{providerDisplayName(account.provider)}</p>
                  <p className="truncate text-xs text-muted-foreground">{account.email_address || account.username || account.approved_scopes}</p>
                </div>
                <Badge variant="outline">{t("userProfile.connectedAccounts.connected")}</Badge>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={() => setConnectProvider(account.provider.replace(/^oauth_/, ""))}
                >
                  {t("userProfile.connectedAccounts.reconnect")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  aria-label={`${t("userProfile.connectedAccounts.disconnect")} ${providerDisplayName(account.provider)}`}
                  onClick={() => setDisconnectTarget(account)}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {availableProviders.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availableProviders.map((provider) => (
              <Button
                key={provider.id}
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setConnectProvider(provider.id)}
              >
                <ProviderIcon provider={provider.id} />
                {provider.name}
              </Button>
            ))}
          </div>
        ) : null}
      </section>

      <EnterpriseAccountsSection />

      <Button type="button" variant="link" className="mx-auto h-auto p-0" onClick={() => onNavigate("security")}>
        {t("userProfile.nav.security")}
      </Button>

      <EmailAddressDialog
        open={emailDialog.open}
        email={emailDialog.email}
        user={user}
        onOpenChange={(open) => setEmailDialog({ open })}
        onError={(caught) => setError(messageFor(t, caught))}
        onVerified={() => void runAction(async () => undefined, t("userProfile.emailAddresses.verifiedToast"))}
      />
      <PhoneNumberDialog
        open={phoneDialog.open}
        phone={phoneDialog.phone}
        user={user}
        onOpenChange={(open) => setPhoneDialog({ open })}
        onError={(caught) => setError(messageFor(t, caught))}
        onVerified={() => void runAction(async () => undefined, t("userProfile.emailAddresses.verifiedToast"))}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title={
          removeTarget?.kind === "email"
            ? t("userProfile.emailAddresses.remove")
            : t("userProfile.phoneNumbers.remove")
        }
        description={
          removeTarget
            ? removeTarget.kind === "email"
              ? t("userProfile.emailAddresses.removeConfirm", { identifier: removeTarget.identifier })
              : t("userProfile.phoneNumbers.removeConfirm", { identifier: removeTarget.identifier })
            : undefined
        }
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!target) return;
          if (target.kind === "email") {
            const resource = findEmail(user, target.id);
            void runAction(async () => {
              if (!resource?.destroy) throw new Error(t("common.internalError"));
              await resource.destroy();
            });
          } else {
            const resource = findPhone(user, target.id);
            void runAction(async () => {
              if (!resource?.destroy) throw new Error(t("common.internalError"));
              await resource.destroy();
            });
          }
        }}
      />
      <ConnectAccountDialog
        open={connectProvider !== null}
        provider={connectProvider}
        onOpenChange={(open) => {
          if (!open) setConnectProvider(null);
        }}
        onError={(caught) => setError(messageFor(t, caught))}
      />
      <ConfirmDialog
        open={disconnectTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        title={t("userProfile.connectedAccounts.disconnect")}
        description={
          disconnectTarget
            ? t("userProfile.connectedAccounts.disconnectConfirm", {
                provider: providerDisplayName(disconnectTarget.provider),
              })
            : undefined
        }
        destructive
        onConfirm={() => {
          const account = disconnectTarget;
          setDisconnectTarget(null);
          if (!account) return;
          void runAction(async () => {
            if (!account.destroy) throw new Error(t("common.internalError"));
            await account.destroy();
          });
        }}
      />
    </div>
  );
}

function emailVerificationStatus(resource: { verification?: unknown }): string | null {
  if (typeof resource.verification !== "object" || resource.verification === null) return null;
  const status = Reflect.get(resource.verification, "status");
  return typeof status === "string" ? status : null;
}

function providerDisplayName(provider: string): string {
  return provider.replace(/^oauth_/, "").replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function messageFor(t: TranslateFn, caught: unknown): string {
  return errorMessage(t, caught);
}

function ProfileImageEditor({
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

function ProfileForm({
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
          <Field control={form.control} name="firstName" label={t("formFieldLabel__firstName")}>
            {(field) => <Input {...field} autoComplete="given-name" />}
          </Field>
        ) : null}
        {environment.attributes.last_name.enabled ? (
          <Field control={form.control} name="lastName" label={t("formFieldLabel__lastName")}>
            {(field) => <Input {...field} autoComplete="family-name" />}
          </Field>
        ) : null}
      </div>
      {environment.attributes.username.enabled ? (
        <Field control={form.control} name="username" label={t("formFieldLabel__username")}>
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

function EmailAddressDialog({
  open,
  email,
  user,
  onOpenChange,
  onVerified,
  onError,
}: {
  open: boolean;
  email?: EmailAddressResource;
  user: OrbitUser;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
  onError: (caught: unknown) => void;
}) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [resource, setResource] = useState<EmailAddressResource | undefined>(email);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"add" | "verify">(email ? "verify" : "add");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResource(email);
    setStage(email ? "verify" : "add");
    setAddress(email?.email_address ?? "");
    setCode("");
    setDialogError(null);
    if (email) {
      void prepareEmailVerification(email).catch((caught) => onError(caught));
    }
  }, [open, email]);

  const add = async () => {
    if (!address.trim()) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (!user.createEmailAddress) throw new Error(t("common.internalError"));
      const created = await user.createEmailAddress({ email: address.trim() });
      setResource(created);
      await prepareEmailVerification(created);
      setStage("verify");
    } catch (caught) {
      setDialogError(messageFor(t, caught));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!resource) return;
    setBusy(true);
    setDialogError(null);
    try {
      await attemptEmailVerification(resource, value);
      onOpenChange(false);
      onVerified();
    } catch (caught) {
      setDialogError(messageFor(t, caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage === "add" ? t("userProfile.emailAddresses.add") : t("userProfile.emailAddresses.verifyTitle")}
          </DialogTitle>
          <DialogDescription>
            {stage === "verify"
              ? t("userProfile.emailAddresses.verifySubtitle", { identifier: resource?.email_address ?? address })
              : t("userProfile.emailAddresses.description")}
          </DialogDescription>
        </DialogHeader>
        <FormError message={dialogError} />
        {stage === "add" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-email">{t("formFieldLabel__emailAddress")}</Label>
              <Input
                id="new-email"
                type="email"
                autoComplete="email"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder={t("formFieldPlaceholder__emailAddress")}
                autoFocus
                disabled={busy}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !address.trim()}>
                {t("common.add")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <OtpField
              value={code}
              onChange={setCode}
              onComplete={(value) => void verify(value)}
              label={t("formFieldLabel__code")}
              disabled={busy}
              autoFocus
            />
            <div className="flex justify-between">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                disabled={busy}
                onClick={() => void (resource ? prepareEmailVerification(resource) : Promise.resolve())}
              >
                {t("common.resend")}
              </Button>
              <Button type="button" disabled={busy || code.length < 6} onClick={() => void verify(code)}>
                {t("common.verify")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PhoneNumberDialog({
  open,
  phone,
  user,
  onOpenChange,
  onVerified,
  onError,
  reservedForSecondFactor = false,
}: {
  open: boolean;
  phone?: PhoneNumberResource;
  user: OrbitUser;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
  onError: (caught: unknown) => void;
  reservedForSecondFactor?: boolean;
}) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [resource, setResource] = useState<PhoneNumberResource | undefined>(phone);
  const [number, setNumber] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"add" | "verify">(phone ? "verify" : "add");
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setResource(phone);
    setStage(phone ? "verify" : "add");
    setNumber(phone?.phone_number ?? "");
    setCode("");
    setDialogError(null);
    if (phone) void preparePhoneVerification(phone).catch((caught) => onError(caught));
  }, [open, phone]);

  const add = async () => {
    if (!number.trim()) return;
    setBusy(true);
    setDialogError(null);
    try {
      if (!user.createPhoneNumber) throw new Error(t("common.internalError"));
      const created = await user.createPhoneNumber({ phoneNumber: number.trim() });
      const normalizedPhone = normalizePhone(created);
      if (reservedForSecondFactor) await normalizedPhone?.update?.({ reservedForSecondFactor: true });
      setResource(normalizedPhone ?? created);
      await preparePhoneVerification(created);
      setStage("verify");
    } catch (caught) {
      setDialogError(messageFor(t, caught));
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (!resource) return;
    setBusy(true);
    setDialogError(null);
    try {
      await attemptPhoneVerification(resource, value);
      onOpenChange(false);
      onVerified();
    } catch (caught) {
      setDialogError(messageFor(t, caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {stage === "add" ? t("userProfile.phoneNumbers.add") : t("userProfile.phoneNumbers.verifyTitle")}
          </DialogTitle>
          <DialogDescription>
            {stage === "verify"
              ? t("userProfile.phoneNumbers.verifySubtitle", { identifier: resource?.phone_number ?? number })
              : t("userProfile.phoneNumbers.description")}
          </DialogDescription>
        </DialogHeader>
        <FormError message={dialogError} />
        {stage === "add" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label>{t("formFieldLabel__phoneNumber")}</Label>
              <PhoneInput value={number} onChange={setNumber} disabled={busy} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !number.trim()}>
                {t("common.add")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <OtpField
              value={code}
              onChange={setCode}
              onComplete={(value) => void verify(value)}
              label={t("formFieldLabel__code")}
              disabled={busy}
              autoFocus
            />
            <div className="flex justify-between">
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                disabled={busy}
                onClick={() => void (resource ? preparePhoneVerification(resource) : Promise.resolve())}
              >
                {t("common.resend")}
              </Button>
              <Button type="button" disabled={busy || code.length < 6} onClick={() => void verify(code)}>
                {t("common.verify")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectAccountDialog({
  open,
  provider,
  onOpenChange,
  onError,
}: {
  open: boolean;
  provider: string | null;
  onOpenChange: (open: boolean) => void;
  onError: (caught: unknown) => void;
}) {
  const runtime = useAuthRuntime();
  const { t, orbit, environment } = runtime;
  const [scopes, setScopes] = useState("");
  const [busy, setBusy] = useState(false);
  const display = environment.social.find((candidate) => candidate.id === provider)?.name ?? provider ?? "";

  const connect = async () => {
    const user = currentUser(orbit);
    if (!user?.createExternalAccount || !provider) return;
    setBusy(true);
    try {
      const redirectUrl = typeof window === "undefined" ? undefined : window.location.href;
      const result = await user.createExternalAccount({
        strategy: provider.startsWith("oauth_") ? provider : `oauth_${provider}`,
        redirectUrl,
        ...(scopes.trim() ? { additionalScopes: scopes.trim().split(/\s+/) } : {}),
      });
      const redirect = extractRedirect(result);
      if (redirect) {
        if (/^https?:/i.test(redirect) && typeof window !== "undefined" && !redirect.startsWith(window.location.origin)) {
          window.location.assign(redirect);
        } else {
          runtime.navigate(redirect);
        }
        return;
      }
      onOpenChange(false);
      await reloadOrbit(orbit);
      runtime.refresh();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider={provider ?? ""} className="size-5" />
            {t("userProfile.connectedAccounts.connect")} {display}
          </DialogTitle>
          <DialogDescription>{t("userProfile.connectedAccounts.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-scopes">{t("userProfile.connectedAccounts.scopes")}</Label>
          <Textarea
            id="account-scopes"
            value={scopes}
            onChange={(event) => setScopes(event.target.value)}
            placeholder={t("userProfile.connectedAccounts.scopesHint")}
            rows={2}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void connect()}>
            <LinkIcon className="size-4" aria-hidden="true" />
            {t("userProfile.connectedAccounts.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function extractRedirect(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const verification = Reflect.get(result, "verification");
  if (typeof verification !== "object" || verification === null) return null;
  const url = Reflect.get(verification, "external_verification_redirect_url");
  return typeof url === "string" ? url : null;
}

function EnterpriseAccountsSection() {
  const runtime = useAuthRuntime();
  const { orbit, t } = runtime;
  const [accounts, setAccounts] = useState<unknown[]>([]);
  const user = currentUser(orbit);

  useEffect(() => {
    let cancelled = false;
    if (!user?.getEnterpriseAccounts) return;
    void user
      .getEnterpriseAccounts()
      .then((result) => {
        if (!cancelled) setAccounts(Array.isArray(result) ? result : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (accounts.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-orbit-section="enterprise-accounts">
      <div>
        <h2 className="text-sm font-semibold">{t("userProfile.enterpriseAccounts.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("userProfile.enterpriseAccounts.description")}</p>
      </div>
      <ul className="flex flex-col divide-y rounded-md border">
        {accounts.map((account, index) => {
          const name =
            typeof account === "object" && account !== null
              ? Reflect.get(account, "enterprise_connection_name") ?? Reflect.get(account, "name")
              : null;
          return (
            <li key={index} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span>{typeof name === "string" ? name : t("userProfile.enterpriseAccounts.title")}</span>
              <Badge variant="outline">{t("userProfile.connectedAccounts.connected")}</Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export { EmailAddressDialog, PhoneNumberDialog, messageFor };
