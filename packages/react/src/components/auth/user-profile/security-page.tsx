import { useEffect, useState } from "react";
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
  Label,
  Separator,
  Switch,
} from "@orbitid/ui";
import { CopyIcon, DownloadIcon, KeyRoundIcon, PlusIcon, PrinterIcon, Trash2Icon } from "lucide-react";
import { currentUser, findPhone, invokeMethod, reloadOrbit } from "../_shared/api";
import { copyText, downloadText, printText } from "../_shared/clipboard";
import { normalizeSession } from "../_shared/normalize";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { FormError } from "../_shared/form-error";
import { OtpField } from "../_shared/otp-field";
import { PasswordField } from "../_shared/password-field";
import { PhoneNumberDialog, messageFor } from "./profile-page";
import { useReverification } from "../../../hooks";
import { useAuthRuntime } from "../_shared/w6";
import type { NormalizedSession, OrbitUser } from "../_shared/w6";
import { isRecord } from "../_shared/guards";

interface SectionProps {
  user: OrbitUser;
  refresh: () => Promise<void>;
  onError: (caught: unknown) => void;
  onNotice: (message: string) => void;
}

export function SecurityPage({ onNavigate }: { onNavigate: (page: string) => void }) {
  const runtime = useAuthRuntime();
  const { orbit, t } = runtime;
  const user = currentUser(orbit);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    await reloadOrbit(orbit);
    runtime.refresh();
  };

  if (!user) {
    return <p className="text-sm text-muted-foreground">{t("userProfile.profile.noUser")}</p>;
  }

  const sectionProps: SectionProps = {
    user,
    refresh,
    onError: (caught) => setError(messageFor(t, caught)),
    onNotice: (message) => {
      setError(null);
      setNotice(message);
    },
  };

  return (
    <div className="flex flex-col gap-6">
      <FormError message={error} />
      {notice ? (
        <p role="status" className="rounded-md border border-emerald-600/20 bg-emerald-600/10 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
          {notice}
        </p>
      ) : null}
      <PasswordSection {...sectionProps} />
      <Separator />
      <PasskeysSection {...sectionProps} />
      <Separator />
      <TotpSection {...sectionProps} />
      <Separator />
      <BackupCodesSection {...sectionProps} />
      <Separator />
      <MfaPhonesSection {...sectionProps} />
      <Separator />
      <DevicesSection {...sectionProps} />
      <Separator />
      <DeleteAccountSection {...sectionProps} onDeleted={() => onNavigate("profile")} />
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function PasswordSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signOutOther, setSignOutOther] = useState(true);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removePassword, setRemovePassword] = useState("");
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;
  const editing = user.password_enabled;

  const submit = async () => {
    if (mismatch) return;
    setBusy(true);
    try {
      await withVerification(() =>
        user.updatePassword?.({
          ...(editing ? { currentPassword } : {}),
          newPassword,
          signOutOfOtherSessions: signOutOther,
        }) ?? Promise.reject(new Error(t("common.internalError"))),
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await refresh();
      onNotice(t("userProfile.password.updated"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      if (!user.removePassword) throw new Error(t("common.internalError"));
      await withVerification(() => user.removePassword?.({ currentPassword: removePassword }) ?? Promise.resolve());
      setRemoving(false);
      setRemovePassword("");
      await refresh();
      onNotice(t("userProfile.password.removed"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" data-orbit-section="password">
      <SectionHeader
        title={t("userProfile.password.title")}
        description={editing ? t("userProfile.password.description") : t("userProfile.password.descriptionNone")}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        {editing ? (
          <PasswordField
            label={t("common.currentPassword")}
            value={currentPassword}
            onChange={setCurrentPassword}
            autoComplete="current-password"
            disabled={busy}
          />
        ) : null}
        <PasswordField
          label={t("common.newPassword")}
          value={newPassword}
          onChange={setNewPassword}
          autoComplete="new-password"
          disabled={busy}
          showStrength
        />
        <PasswordField
          label={t("common.confirmPassword")}
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
          disabled={busy}
          error={mismatch ? t("common.passwordsDoNotMatch") : null}
        />
      </div>
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <Label htmlFor="password-sign-out-others" className="text-sm font-normal">
          {t("userProfile.password.signOutOther")}
        </Label>
        <Switch
          id="password-sign-out-others"
          checked={signOutOther}
          onCheckedChange={setSignOutOther}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !newPassword || mismatch}
          onClick={() => void submit()}
        >
          {editing ? t("userProfile.password.change") : t("userProfile.password.set")}
        </Button>
        {editing ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(true)}>
            {t("userProfile.password.remove")}
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={t("userProfile.password.remove")}
        description={t("userProfile.password.removeConfirm")}
        destructive
        confirmLabel={t("userProfile.password.remove")}
        onConfirm={remove}
      >
        <PasswordField
          label={t("common.currentPassword")}
          value={removePassword}
          onChange={setRemovePassword}
          autoComplete="current-password"
        />
      </ConfirmDialog>
    </section>
  );
}

function PasskeysSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const supported = typeof window !== "undefined" && typeof Reflect.get(window, "PublicKeyCredential") === "function";
  const passkeys = user.passkeys ?? [];

  const add = async () => {
    setBusy(true);
    try {
      await withVerification(() => user.createPasskey?.() ?? Promise.reject(new Error(t("common.internalError"))));
      await refresh();
      onNotice(t("userProfile.passkeys.added"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const target = passkeys.find((passkey) => passkey.id === renameTarget);
    setRenameTarget(null);
    if (!target?.update) return;
    setBusy(true);
    try {
      await target.update({ name: renameValue.trim() });
      await refresh();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const target = passkeys.find((passkey) => passkey.id === deleteTarget);
    setDeleteTarget(null);
    if (!target) return;
    setBusy(true);
    try {
      await target.delete?.();
      await refresh();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-orbit-section="passkeys">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader title={t("userProfile.passkeys.title")} description={t("userProfile.passkeys.description")} />
        <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy || !supported} onClick={() => void add()}>
          <PlusIcon className="size-4" aria-hidden="true" />
          {t("userProfile.passkeys.add")}
        </Button>
      </div>
      {!supported ? <p className="text-xs text-muted-foreground">{t("userProfile.passkeys.unsupported")}</p> : null}
      {passkeys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("userProfile.passkeys.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {passkeys.map((passkey) => (
            <li key={passkey.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
              <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{passkey.name}</p>
                <p className="text-xs text-muted-foreground">
                  {passkey.last_used_at
                    ? t("userProfile.passkeys.lastUsed", { date: formatDate(passkey.last_used_at) })
                    : t("userProfile.passkeys.created", { date: formatDate(passkey.created_at) })}
                </p>
              </div>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => {
                  setRenameTarget(passkey.id);
                  setRenameValue(passkey.name);
                }}
              >
                {t("common.rename")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 text-muted-foreground"
                aria-label={t("userProfile.passkeys.delete")}
                onClick={() => setDeleteTarget(passkey.id)}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={renameTarget !== null} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("common.rename")}</DialogTitle>
            <DialogDescription>{t("userProfile.passkeys.name")}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            placeholder={t("userProfile.passkeys.namePlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={() => void rename()} disabled={!renameValue.trim()}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("userProfile.passkeys.delete")}
        description={t("userProfile.passkeys.deleteConfirm")}
        destructive
        onConfirm={remove}
      />
    </section>
  );
}

function TotpSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [setupOpen, setSetupOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);

  const startSetup = async () => {
    setBusy(true);
    try {
      if (!user.createTOTP) throw new Error(t("common.internalError"));
      const result = await user.createTOTP();
      setSecret(result.secret ?? "");
      setQrCode(result.qr_code ?? result.qrCode ?? result.qrCodeUrl ?? null);
      setSetupOpen(true);
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    setBusy(true);
    try {
      if (!user.verifyTOTP) throw new Error(t("common.internalError"));
      await withVerification(() => user.verifyTOTP?.({ code: value }) ?? Promise.resolve());
      setSetupOpen(false);
      setCode("");
      await refresh();
      onNotice(t("userProfile.totp.enabled"));
    } catch (caught) {
      onError(caught);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    try {
      await withVerification(() => user.disableTOTP?.() ?? Promise.resolve());
      setConfirmDisable(false);
      await refresh();
      onNotice(t("userProfile.totp.disabled"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-orbit-section="totp">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader title={t("userProfile.totp.title")} description={t("userProfile.totp.description")} />
        {user.totp_enabled ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setConfirmDisable(true)}>
            {t("userProfile.totp.disable")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={busy} onClick={() => void startSetup()}>
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("userProfile.totp.add")}
          </Button>
        )}
      </div>
      {user.totp_enabled ? <Badge variant="secondary" className="w-fit">{t("userProfile.totp.title")}</Badge> : null}
      <Dialog open={setupOpen} onOpenChange={setSetupOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("userProfile.totp.verifyTitle")}</DialogTitle>
            <DialogDescription>{t("userProfile.totp.scanQr")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col items-center gap-3">
            {qrCode ? (
              <img src={qrCode} alt={t("userProfile.totp.qrAlt")} className="size-44 rounded-md border bg-white p-2" data-testid="totp-qr" />
            ) : null}
            {secret ? (
              <div className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                <span className="text-xs font-medium text-muted-foreground">{t("userProfile.totp.secret")}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{secret}</code>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={t("common.copy")}
                  onClick={() => void copyText(secret)}
                >
                  <CopyIcon className="size-3.5" />
                </Button>
              </div>
            ) : null}
            <OtpField
              value={code}
              onChange={setCode}
              onComplete={(value) => void verify(value)}
              label={t("formFieldLabel__code")}
              disabled={busy}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSetupOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={busy || code.length < 6} onClick={() => void verify(code)}>
              {t("userProfile.totp.verify")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={t("userProfile.totp.disable")}
        description={t("userProfile.totp.disableConfirm")}
        destructive
        onConfirm={disable}
      />
    </section>
  );
}

function BackupCodesSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      if (!user.createBackupCode) throw new Error(t("common.internalError"));
      const result = await withVerification(() => user.createBackupCode?.() ?? Promise.resolve());
      const list = Array.isArray(result)
        ? result.filter((entry): entry is string => typeof entry === "string")
        : isRecord(result) && Array.isArray(result.codes)
          ? result.codes.filter((entry): entry is string => typeof entry === "string")
          : [];
      setCodes(list);
      await refresh();
      onNotice(t("userProfile.backupCodes.generated"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-orbit-section="backup-codes">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader title={t("userProfile.backupCodes.title")} description={t("userProfile.backupCodes.description")} />
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void generate()}>
          {user.backup_code_enabled ? t("userProfile.backupCodes.regenerate") : t("userProfile.backupCodes.generate")}
        </Button>
      </div>
      {user.backup_code_enabled ? <p className="text-xs text-muted-foreground">{t("userProfile.backupCodes.enabled")}</p> : null}
      <Dialog open={codes !== null} onOpenChange={(open) => !open && setCodes(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("userProfile.backupCodes.title")}</DialogTitle>
            <DialogDescription>{t("userProfile.backupCodes.warning")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 font-mono text-sm" data-testid="backup-codes">
            {(codes ?? []).map((backupCode) => (
              <span key={backupCode} className="rounded bg-background px-2 py-1 text-center">
                {backupCode}
              </span>
            ))}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void copyText((codes ?? []).join("\n"))}>
                <CopyIcon className="size-4" aria-hidden="true" />
                {t("common.copy")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => downloadText(t("userProfile.backupCodes.filename"), (codes ?? []).join("\n"))}>
                <DownloadIcon className="size-4" aria-hidden="true" />
                {t("common.download")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => printText((codes ?? []).join("\n"))}>
                <PrinterIcon className="size-4" aria-hidden="true" />
                {t("common.print")}
              </Button>
            </div>
            <Button type="button" size="sm" onClick={() => setCodes(null)}>
              {t("common.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function MfaPhonesSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const phones = user.phone_numbers ?? [];

  const toggleReserved = async (phoneId: string, reserved: boolean) => {
    const phone = findPhone(user, phoneId);
    setBusy(true);
    try {
      if (!phone?.update) throw new Error(t("common.internalError"));
      await phone.update({ reservedForSecondFactor: reserved });
      await refresh();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (phoneId: string) => {
    const phone = findPhone(user, phoneId);
    setBusy(true);
    try {
      if (!phone?.update) throw new Error(t("common.internalError"));
      await phone.update({ defaultSecondFactor: true });
      await refresh();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-orbit-section="mfa-phones">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader title={t("userProfile.mfaPhones.title")} description={t("userProfile.mfaPhones.description")} />
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
          <PlusIcon className="size-4" aria-hidden="true" />
          {t("userProfile.mfaPhones.add")}
        </Button>
      </div>
      {phones.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("userProfile.mfaPhones.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {phones.map((phone) => (
            <li key={phone.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{phone.phone_number}</span>
              {phone.default_second_factor ? <Badge variant="secondary">{t("userProfile.mfaPhones.default")}</Badge> : null}
              <div className="flex items-center gap-2">
                <Label htmlFor={`mfa-${phone.id}`} className="text-xs font-normal text-muted-foreground">
                  {t("userProfile.phoneNumbers.reservedForMfa")}
                </Label>
                <Switch
                  id={`mfa-${phone.id}`}
                  checked={Boolean(phone.reserved_for_second_factor)}
                  disabled={busy}
                  onCheckedChange={(checked) => void toggleReserved(phone.id, checked)}
                />
              </div>
              {phone.reserved_for_second_factor && !phone.default_second_factor ? (
                <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={() => void setDefault(phone.id)}>
                  {t("userProfile.mfaPhones.setDefault")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <PhoneNumberDialog
        open={addOpen}
        user={user}
        reservedForSecondFactor
        onOpenChange={setAddOpen}
        onVerified={() => {
          onNotice(t("userProfile.phoneNumbers.verified"));
          void refresh();
        }}
        onError={onError}
      />
    </section>
  );
}

function DevicesSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [sessions, setSessions] = useState<NormalizedSession[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const list = user.getSessions ? await user.getSessions() : runtime.client?.sessions ?? [];
      const currentId = runtime.session?.id ?? runtime.client?.last_active_session_id;
      const normalized = list
        .map((session) => normalizeSession(session))
        .filter((session): session is NormalizedSession => session !== null);
      setSessions(normalized.filter((session) => session.id !== currentId && session.status === "active"));
    } catch (caught) {
      onError(caught);
    }
  };

  useEffect(() => {
    void load();
  }, [user]);

  const revoke = async (sessionId: string) => {
    setBusy(true);
    try {
      if (user.revokeSession) {
        await user.revokeSession(sessionId);
      } else {
        const session = runtime.client?.sessions?.find((candidate) => candidate.id === sessionId);
        if (session) {
          await invokeMethod(session, ["revoke", "remove", "end"]);
        } else {
          throw new Error(t("common.internalError"));
        }
      }
      await load();
      await refresh();
      onNotice(t("userProfile.devices.revoked"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    setBusy(true);
    try {
      for (const session of sessions) await revoke(session.id);
      onNotice(t("userProfile.devices.revokedAll"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3" data-orbit-section="devices">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader title={t("userProfile.devices.title")} description={t("userProfile.devices.description")} />
        {sessions.length > 0 ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revokeAll()}>
            {t("userProfile.devices.revokeAll")}
          </Button>
        ) : null}
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("userProfile.devices.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {sessions.map((session) => {
            const activity = session.latest_activity ?? null;
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {[activity?.browser_name, activity?.device_type].filter(Boolean).join(" · ") || t("userProfile.devices.unknownDevice")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[activity?.city, activity?.country].filter(Boolean).join(", ") || t("userProfile.devices.unknownLocation")}
                    {" · "}
                    {t("userProfile.devices.lastActive", { date: formatDate(session.last_active_at) })}
                  </p>
                </div>
                <Button type="button" variant="link" size="sm" className="h-auto p-0" disabled={busy} onClick={() => void revoke(session.id)}>
                  {t("userProfile.devices.revoke")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DeleteAccountSection({ user, onError, onDeleted }: SectionProps & { onDeleted: () => void }) {
  const runtime = useAuthRuntime();
  const { t, environment, navigate } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmWord = t("userProfile.deleteAccount.confirmWord");
  const disabled = !environment.actions.deleteSelf || user.delete_self_enabled === false;

  const remove = async () => {
    setBusy(true);
    try {
      if (!user.delete) throw new Error(t("common.internalError"));
      await withVerification(() => user.delete?.() ?? Promise.resolve());
      setOpen(false);
      onDeleted();
      navigate(environment.app.homeUrl);
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-md border border-destructive/30 p-3" data-orbit-section="delete-account">
      <SectionHeader title={t("userProfile.deleteAccount.title")} description={t("userProfile.deleteAccount.description")} />
      {disabled ? (
        <p className="text-xs text-muted-foreground">{t("userProfile.deleteAccount.disabled")}</p>
      ) : (
        <Button type="button" variant="destructive" size="sm" className="w-fit" onClick={() => setOpen(true)}>
          {t("userProfile.deleteAccount.action")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("userProfile.deleteAccount.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("userProfile.deleteAccount.confirmSubtitle")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirmation">{t("userProfile.deleteAccount.confirmHint")}</Label>
            <Input
              id="delete-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={confirmWord}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || confirmation !== confirmWord}
              onClick={() => void remove()}
            >
              {t("userProfile.deleteAccount.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function formatDate(value: number | null | undefined): string {
  if (!value) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}


