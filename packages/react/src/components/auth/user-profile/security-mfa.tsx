import { useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Switch,
} from "@orbitid/ui";
import { CopyIcon, DownloadIcon, PlusIcon, PrinterIcon } from "lucide-react";
import { findPhone } from "../_shared/api";
import { copyText, downloadText, printText } from "../_shared/clipboard";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { OtpField } from "../_shared/otp-field";
import { PhoneNumberDialog } from "./email-phone-dialogs";
import { useReverification } from "../../../hooks";
import { useAuthRuntime } from "../_shared/w6";
import { isRecord } from "../_shared/guards";
import { SectionHeader, type SectionProps } from "./security-shared";

export function TotpSection({ user, refresh, onError, onNotice }: SectionProps) {
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

export function BackupCodesSection({ user, refresh, onError, onNotice }: SectionProps) {
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

export function MfaPhonesSection({ user, refresh, onError, onNotice }: SectionProps) {
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
