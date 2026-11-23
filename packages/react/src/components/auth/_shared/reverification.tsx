import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@orbitid/ui";
import { errorMessage, invokeMethod, primaryIdentifier } from "./api";
import { useElementClasses, useThemeScope } from "./appearance";
import { FormError } from "./form-error";
import { OtpField } from "./otp-field";
import { PasswordField } from "./password-field";
import { useAuthRuntime } from "./w6";

export interface ReverificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
  onCancel: () => void;
  title?: string;
  subtitle?: string;
  /** Ask for a second factor after the first one (multi-factor reverification). */
  requireSecondFactor?: boolean;
}

interface SessionVerification {
  attemptFirstFactor?(params: Record<string, unknown>): Promise<unknown>;
  prepareFirstFactor?(params: Record<string, unknown>): Promise<unknown>;
  attemptSecondFactor?(params: Record<string, unknown>): Promise<unknown>;
  status?: string;
}

function verificationStatus(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const status = Reflect.get(result, "status");
  return typeof status === "string" ? status : null;
}

/** First-factor (password or email code) then optional second-factor reverification dialog. */
export function ReverificationDialog({
  open,
  onOpenChange,
  onVerified,
  onCancel,
  title,
  subtitle,
  requireSecondFactor = false,
}: ReverificationDialogProps) {
  const runtime = useAuthRuntime();
  const { t, environment, orbit } = runtime;
  const { el } = useElementClasses();
  // Portaled to <body>: carry the component's scheme so the dialog matches the page it was opened from.
  const { className: themeClass } = useThemeScope();
  const user = runtime.user;
  const [stage, setStage] = useState<"first" | "email_code" | "second">("first");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verification = useRef<SessionVerification | null>(null);
  const passwordAvailable = Boolean(user?.password_enabled) && environment.attributes.password.enabled;
  const email = user ? primaryIdentifier(user) : "";
  const secondStrategy = user?.totp_enabled ? "totp" : user?.backup_code_enabled ? "backup_code" : "phone_code";

  useEffect(() => {
    if (!open) return;
    setStage("first");
    setPassword("");
    setCode("");
    setError(null);
    verification.current = null;
  }, [open]);

  const startVerification = async (): Promise<SessionVerification> => {
    if (verification.current) return verification.current;
    const session = orbit.session;
    const started = await invokeMethod<SessionVerification>(session, ["startVerification", "start_verification"]);
    verification.current = started;
    return started;
  };

  const finish = () => {
    onVerified();
    onOpenChange(false);
  };

  const handleFirstResult = async (result: unknown, current: SessionVerification) => {
    const needsSecond = requireSecondFactor && verificationStatus(result) !== "failed";
    if (needsSecond) {
      if (secondStrategy === "phone_code") {
        await invokeMethod(current, ["prepareSecondFactor", "prepare_second_factor"], { strategy: "phone_code" });
      }
      setStage("second");
      setCode("");
      return;
    }
    finish();
  };

  const submitPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await startVerification();
      const result = await invokeMethod(current, ["attemptFirstFactor", "attempt_first_factor"], {
        strategy: "password",
        password,
      });
      await handleFirstResult(result, current);
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  };

  const sendEmailCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = await startVerification();
      await invokeMethod(current, ["prepareFirstFactor", "prepare_first_factor"], { strategy: "email_code" });
      setStage("email_code");
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  };

  const submitEmailCode = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const current = await startVerification();
      const result = await invokeMethod(current, ["attemptFirstFactor", "attempt_first_factor"], {
        strategy: "email_code",
        code: value,
      });
      await handleFirstResult(result, current);
    } catch (caught) {
      setError(errorMessage(t, caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const submitSecondFactor = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const current = await startVerification();
      await invokeMethod(current, ["attemptSecondFactor", "attempt_second_factor"], {
        strategy: secondStrategy,
        code: value,
      });
      finish();
    } catch (caught) {
      setError(errorMessage(t, caught));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    onCancel();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className={cn(themeClass, "max-w-md", el("modalContent"))} data-orbit-component="verification-modal">
        <DialogHeader>
          <DialogTitle>{title ?? t("verification.title")}</DialogTitle>
          <DialogDescription>
            {subtitle ?? (stage === "second" ? t("verification.secondFactorSubtitle") : t("verification.subtitle"))}
          </DialogDescription>
        </DialogHeader>
        <FormError message={error} />

        {stage === "first" ? (
          passwordAvailable ? (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submitPassword();
              }}
            >
              <PasswordField
                label={t("common.password")}
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                autoFocus
                disabled={busy}
              />
              <Button type="submit" disabled={busy || !password}>
                {t("common.verify")}
              </Button>
              {email ? (
                <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => void sendEmailCode()}>
                  {t("verification.emailCode", { identifier: email })}
                </Button>
              ) : null}
            </form>
          ) : (
            <Button type="button" disabled={busy || !email} onClick={() => void sendEmailCode()}>
              {t("verification.sendCode")}
            </Button>
          )
        ) : null}

        {stage === "email_code" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{t("verification.codeSubtitle", { identifier: email })}</p>
            <OtpField value={code} onChange={setCode} onComplete={(value) => void submitEmailCode(value)} disabled={busy} />
            <Button type="button" disabled={busy || code.length < 6} onClick={() => void submitEmailCode(code)}>
              {t("common.verify")}
            </Button>
          </div>
        ) : null}

        {stage === "second" ? (
          <div className="flex flex-col gap-3">
            <OtpField
              value={code}
              onChange={setCode}
              onComplete={(value) => void submitSecondFactor(value)}
              disabled={busy}
              label={t("formFieldLabel__code")}
            />
            <Button type="button" disabled={busy || code.length < 6} onClick={() => void submitSecondFactor(code)}>
              {t("common.verify")}
            </Button>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
