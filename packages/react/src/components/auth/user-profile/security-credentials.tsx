import { useState } from "react";
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
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { PasswordField } from "../_shared/password-field";
import { useReverification } from "../../../hooks";
import { useAuthRuntime } from "../_shared/w6";
import { SectionHeader, formatDate, type SectionProps } from "./security-shared";

export function PasswordSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // Opt-in, never the default: changing a password must not silently sign the user out of their other devices.
  const [signOutOther, setSignOutOther] = useState(false);
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

export function PasskeysSection({ user, refresh, onError, onNotice }: SectionProps) {
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
                className="h-auto min-h-6 px-0 py-1"
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
