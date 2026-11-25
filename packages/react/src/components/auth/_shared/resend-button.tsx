import { useEffect, useState } from "react";
import { Button, cn } from "@orbitid/ui";
import { useComponentElements } from "./appearance";
import { useAuthRuntime } from "./w6";

export interface ResendButtonProps {
  onResend: () => Promise<void> | void;
  /** Seconds before the button becomes clickable again. */
  cooldownSeconds?: number;
  label?: string;
  disabled?: boolean;
  className?: string;
  onError?: (error: unknown) => void;
}

/** "Resend code" link with a countdown and accessible live announcement. */
export function ResendButton({
  onResend,
  cooldownSeconds = 30,
  label,
  disabled,
  className,
  onError,
}: ResendButtonProps) {
  const { t } = useAuthRuntime();
  const { ep } = useComponentElements();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const countingDown = secondsLeft > 0;

  useEffect(() => {
    if (!countingDown) return;
    const id = window.setInterval(() => setSecondsLeft((current) => Math.max(0, current - 1)), 1000);
    return () => window.clearInterval(id);
  }, [countingDown]);

  const handleClick = async () => {
    if (busy || secondsLeft > 0) return;
    setBusy(true);
    try {
      await onResend();
      setSecondsLeft(cooldownSeconds);
    } catch (error) {
      onError?.(error);
    } finally {
      setBusy(false);
    }
  };

  const unavailable = disabled || busy || secondsLeft > 0;

  return (
    <div className="flex flex-col items-center gap-1">
      <Button
        type="button"
        variant="link"
        size="sm"
        disabled={unavailable}
        onClick={handleClick}
        {...ep("formResendCodeLink", "h-auto min-h-6 px-0 py-1 text-sm font-medium text-muted-foreground hover:text-foreground", className)}
      >
        {secondsLeft > 0 ? t("signIn.emailCode.resendIn", { seconds: secondsLeft }) : label ?? t("common.resend")}
      </Button>
      <span aria-live="polite" className="sr-only">
        {secondsLeft > 0 ? t("signIn.emailCode.resendIn", { seconds: secondsLeft }) : ""}
      </span>
    </div>
  );
}
