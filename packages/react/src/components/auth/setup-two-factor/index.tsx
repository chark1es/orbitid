import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Label, cn } from "@orbitid/ui";
import { CopyIcon, DownloadIcon, Loader2Icon, ShieldCheckIcon } from "lucide-react";
import type { Appearance } from "../../../appearance/types";
import type { TOTPResource } from "../../../provider/types";
import { activateSession, errorMessage, invokeMethod, refreshClient, toAuthError } from "../_shared/api";
import { AuthAppearanceScope, useElementClasses } from "../_shared/appearance";
import { AuthCard } from "../_shared/auth-card";
import { copyText, downloadText } from "../_shared/clipboard";
import { FormError } from "../_shared/form-error";
import { AuthLoadingScreen } from "../_shared/loading";
import { OtpField } from "../_shared/otp-field";
import { PhoneInput } from "../_shared/phone-input";
import { useAuthRuntime } from "../_shared/w6";

export interface TwoFactorSetupProps {
  /** Pending session created by sign-in; activated once the second factor is verified. */
  sessionId?: string | null;
  /** Called after activation, in place of navigation. */
  onComplete?: () => void;
  /** Where to send the user after activation. */
  redirectUrl?: string;
  className?: string;
}

export interface SetupTwoFactorProps extends TwoFactorSetupProps {
  appearance?: Appearance;
}

type Phase = "totp" | "phone" | "phone-code" | "backup";

interface TotpSetup {
  secret: string;
  qrCode: string | null;
}

/** Plaintext codes from `POST /me/totp/attempt_verification` (shape varies by SDK build). */
function readBackupCodes(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const list =
    "backupCodes" in value ? value.backupCodes : "backup_codes" in value ? value.backup_codes : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    if (typeof item === "string") return [item];
    if (item && typeof item === "object" && "code" in item && typeof item.code === "string") {
      return [item.code];
    }
    return [];
  });
}

/**
 * Second-factor enrolment for a session the server created as `pending` (required MFA and no
 * factor yet). The pending session may only read `/me`, manage `/me/totp` and manage
 * `/me/phone_numbers`, so every request here stays inside that set. Verifying a factor makes
 * the server activate the session; `sessionId` is then passed to `setActive`.
 */
export function TwoFactorSetup({ sessionId, onComplete, redirectUrl, className }: TwoFactorSetupProps) {
  const runtime = useAuthRuntime();
  const { environment, orbit, t, navigate, user } = runtime;
  const { ep } = useElementClasses();
  const [phase, setPhase] = useState<Phase>("totp");
  const [totp, setTotp] = useState<TotpSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [phoneValue, setPhoneValue] = useState("");
  const [phone, setPhone] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  const phoneSecondFactor =
    environment.attributes.phone_number.enabled && environment.attributes.phone_number.usedForSecondFactor;

  const startTotp = useCallback(async () => {
    if (!user?.createTOTP) {
      setError(t("common.internalError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result: TOTPResource = await user.createTOTP();
      setTotp({
        secret: result.secret ?? "",
        qrCode: result.qr_code ?? result.qrCode ?? result.qrCodeUrl ?? null,
      });
      setPhase("totp");
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  }, [t, user]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startTotp();
  }, [startTotp]);

  const finish = useCallback(async () => {
    // Standalone use: the pending session on the instance is the one this enrolment belongs to.
    const target =
      sessionId ?? (runtime.session?.status === "pending" ? runtime.session.id : null);
    setBusy(true);
    setError(null);
    try {
      if (target) await activateSession(orbit, target);
      await refreshClient(orbit);
      runtime.refresh();
      if (onComplete) onComplete();
      else if (redirectUrl) navigate(redirectUrl, { replace: true });
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  }, [navigate, onComplete, orbit, redirectUrl, runtime, sessionId, t]);

  const verifyTotp = useCallback(
    async (value: string) => {
      if (!user?.verifyTOTP) {
        setError(t("common.internalError"));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await user.verifyTOTP({ code: value });
        setCodes(readBackupCodes(result));
        setCode("");
        setPhase("backup");
        runtime.refresh();
      } catch (caught) {
        setError(errorMessage(t, caught));
        setCode("");
      } finally {
        setBusy(false);
      }
    },
    [runtime, t, user],
  );

  const sendPhoneCode = useCallback(async () => {
    if (!user?.createPhoneNumber) {
      setError(t("common.internalError"));
      return;
    }
    const value = phoneValue.trim();
    if (!value) {
      setError(t("formFieldError__required"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await user.createPhoneNumber({ phoneNumber: value });
      await invokeMethod(created, ["prepareVerification", "prepare_verification"], { strategy: "phone_code" });
      setPhone(created);
      setPhase("phone-code");
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  }, [phoneValue, t, user]);

  const verifyPhone = useCallback(
    async (value: string) => {
      if (!phone) {
        setError(t("common.internalError"));
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await invokeMethod(phone, ["attemptVerification", "attempt_verification"], { code: value });
        try {
          await invokeMethod(phone, ["makeDefaultSecondFactor"]);
        } catch (caught) {
          if (toAuthError(caught).code !== "not_supported") throw caught;
          await invokeMethod(phone, ["setReservedForSecondFactor", "update"], { reserved: true });
        }
        setCode("");
        setCodes([]);
        setPhase("backup");
        runtime.refresh();
      } catch (caught) {
        setError(errorMessage(t, caught));
        setCode("");
      } finally {
        setBusy(false);
      }
    },
    [phone, runtime, t],
  );

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <FormError
        message={error}
        onRetry={phase === "totp" && !totp ? () => void startTotp() : undefined}
      />

      {phase === "totp" ? (
        <>
          {totp ? (
            <>
              <p className="text-sm text-muted-foreground">{t("signIn.setupTwoFactor.scanQr")}</p>
              <div className="flex flex-col items-center gap-3">
                {totp.qrCode ? (
                  <img
                    src={totp.qrCode}
                    alt={t("userProfile.totp.qrAlt")}
                    data-testid="setup-two-factor-qr"
                    className="size-44 rounded-md border bg-white p-2"
                  />
                ) : null}
                {totp.secret ? (
                  <div className="flex w-full items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("signIn.setupTwoFactor.secret")}
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="setup-two-factor-secret">
                      {totp.secret}
                    </code>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={t("signIn.setupTwoFactor.copySecret")}
                      onClick={() => void copyText(totp.secret)}
                    >
                      <CopyIcon className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                ) : null}
              </div>
              <OtpField
                value={code}
                onChange={setCode}
                onComplete={(value) => void verifyTotp(value)}
                label={t("signIn.setupTwoFactor.codeLabel")}
                disabled={busy}
                autoFocus
              />
              <Button
                type="button"
                disabled={busy || code.length < 6}
                {...ep("formButtonPrimary", "w-full")}
                onClick={() => void verifyTotp(code)}
              >
                {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
                {t("signIn.setupTwoFactor.verify")}
              </Button>
            </>
          ) : busy ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" aria-live="polite">
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {t("common.loading")}
            </div>
          ) : null}
          {phoneSecondFactor ? (
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-6 px-0 py-1 text-sm font-medium"
              disabled={busy}
              onClick={() => {
                setError(null);
                setPhase("phone");
              }}
            >
              {t("signIn.setupTwoFactor.usePhone")}
            </Button>
          ) : null}
        </>
      ) : null}

      {phase === "phone" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="setup-two-factor-phone" className="text-sm font-medium">
              {t("signIn.setupTwoFactor.phoneLabel")}
            </Label>
            <PhoneInput
              id="setup-two-factor-phone"
              value={phoneValue}
              onChange={setPhoneValue}
              disabled={busy}
              autoFocus
            />
          </div>
          <Button
            type="button"
            disabled={busy || phoneValue.trim().length === 0}
            {...ep("formButtonPrimary", "w-full")}
            onClick={() => void sendPhoneCode()}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("signIn.setupTwoFactor.sendCode")}
          </Button>
          <Button
            type="button"
            variant="link"
            className="h-auto min-h-6 px-0 py-1 text-sm font-medium"
            disabled={busy}
            onClick={() => {
              setError(null);
              setPhase("totp");
            }}
          >
            {t("signIn.setupTwoFactor.useAuthenticator")}
          </Button>
        </>
      ) : null}

      {phase === "phone-code" ? (
        <>
          <OtpField
            value={code}
            onChange={setCode}
            onComplete={(value) => void verifyPhone(value)}
            label={t("signIn.setupTwoFactor.phoneCodeLabel")}
            disabled={busy}
            autoFocus
          />
          <Button
            type="button"
            disabled={busy || code.length < 6}
            {...ep("formButtonPrimary", "w-full")}
            onClick={() => void verifyPhone(code)}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("signIn.setupTwoFactor.phoneVerify")}
          </Button>
        </>
      ) : null}

      {phase === "backup" ? (
        <>
          <div className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-go" aria-hidden="true" />
            <p className="text-sm font-medium">{t("signIn.setupTwoFactor.backupTitle")}</p>
          </div>
          {codes.length > 0 ? (
            <>
              <p className="text-sm text-muted-foreground">{t("signIn.setupTwoFactor.backupDescription")}</p>
              <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-3">
                {codes.map((backupCode) => (
                  <span key={backupCode} className="rounded bg-background px-2 py-1 text-center font-mono text-sm" data-testid="setup-two-factor-code">
                    {backupCode}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void copyText(codes.join("\n"))}
                >
                  <CopyIcon className="size-4" aria-hidden="true" />
                  {t("signIn.setupTwoFactor.backupCopy")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() =>
                    downloadText(t("signIn.setupTwoFactor.backupFilename"), codes.join("\n"))
                  }
                >
                  <DownloadIcon className="size-4" aria-hidden="true" />
                  {t("signIn.setupTwoFactor.backupDownload")}
                </Button>
              </div>
            </>
          ) : null}
          <Button
            type="button"
            disabled={busy}
            {...ep("formButtonPrimary", "w-full")}
            onClick={() => void finish()}
          >
            {busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("signIn.setupTwoFactor.continue")}
          </Button>
        </>
      ) : null}
    </div>
  );
}

function SetupTwoFactorInner({ appearance: _appearance, ...props }: SetupTwoFactorProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  if (!runtime.loaded) return <AuthLoadingScreen />;
  return (
    <div className="flex w-full items-center justify-center px-4 py-6">
      <AuthCard
        title={t("signIn.setupTwoFactor.title")}
        subtitle={t("signIn.setupTwoFactor.subtitle")}
      >
        <TwoFactorSetup {...props} />
      </AuthCard>
    </div>
  );
}

/** Standalone required-MFA enrolment screen: the same step `<SignIn/>` renders, with its own card. */
export function SetupTwoFactor(props: SetupTwoFactorProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <SetupTwoFactorInner {...props} />
    </AuthAppearanceScope>
  );
}
