import { useEffect, useState } from "react";
import { Button, cn } from "@orbitid/ui";
import { Loader2Icon, MailIcon } from "lucide-react";
import { useAuthRuntime } from "../../_shared/w6";
import { useComponentElements } from "../../_shared/appearance";
import { FormError } from "../../_shared/form-error";
import { OtpField } from "../../_shared/otp-field";
import { ResendButton } from "../../_shared/resend-button";
import { type SignUpStepProps } from "./shared";

export function VerifyCodeStep({ flow, strategy }: SignUpStepProps & { strategy: "email_code" | "phone_code" }) {
  const { t } = useAuthRuntime();
  const { ep } = useComponentElements();
  const [code, setCode] = useState("");
  const identifier =
    strategy === "phone_code"
      ? flow.signUp?.phone_number ?? flow.initialForm.phoneNumber
      : flow.signUp?.email_address ?? flow.initialForm.emailAddress;

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <p className="text-center text-sm text-muted-foreground">
        {strategy === "phone_code"
          ? t("signUp.verifyPhoneCode.subtitle", { identifier })
          : t("signUp.verifyEmailCode.subtitle", { identifier })}
      </p>
      <OtpField
        value={code}
        onChange={setCode}
        onComplete={(value) => void flow.attemptVerification(strategy, value)}
        label={t("formFieldLabel__code")}
        disabled={flow.busy}
        autoFocus
      />
      <Button
        type="button"
        disabled={flow.busy || code.length < 6}
        {...ep("formButtonPrimary", "w-full")}
        onClick={() => void flow.attemptVerification(strategy, code)}
      >
        {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {strategy === "phone_code" ? t("signUp.verifyPhoneCode.action") : t("signUp.verifyEmailCode.action")}
      </Button>
      <ResendButton
        onResend={() => flow.prepareVerification(strategy).then(() => undefined)}
        onError={(error) => flow.setError(error instanceof Error ? error.message : t("errors.unexpected"))}
        disabled={flow.busy}
      />
    </div>
  );
}

export function VerifyEmailLinkStep({ flow }: SignUpStepProps) {
  const { t } = useAuthRuntime();
  const identifier = flow.signUp?.email_address ?? flow.initialForm.emailAddress;
  const { pollCompletion } = flow;

  useEffect(() => {
    const poll = () => void pollCompletion();
    const interval = window.setInterval(poll, 4000);
    window.addEventListener("focus", poll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", poll);
    };
  }, [pollCompletion]);

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <MailIcon className="mx-auto size-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-center text-sm text-muted-foreground">
        {t("signUp.verifyEmailLink.subtitle", { identifier })}
      </p>
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        {t("signIn.emailLink.waiting")}
      </div>
      <Button type="button" variant="outline" disabled={flow.busy} onClick={() => void pollCompletion()}>
        {t("signUp.verifyEmailLink.iAlreadyClicked")}
      </Button>
      <ResendButton
        onResend={() => flow.prepareVerification("email_link").then(() => undefined)}
        onError={(error) => flow.setError(error instanceof Error ? error.message : t("errors.unexpected"))}
        disabled={flow.busy}
      />
    </div>
  );
}
