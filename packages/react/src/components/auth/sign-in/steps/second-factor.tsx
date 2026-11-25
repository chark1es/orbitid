import { useState } from "react";
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@orbitid/ui";
import { Loader2Icon } from "lucide-react";
import { factorsOf } from "../../_shared/api";
import { useAuthRuntime, type TranslateFn } from "../../_shared/w6";
import { useElementClasses, usePortalClass } from "../../_shared/appearance";
import { FormError } from "../../_shared/form-error";
import { OtpField } from "../../_shared/otp-field";
import { LinkButton, type StepProps } from "./shared";

export function SecondFactorStep({ flow }: StepProps) {
  const portalClass = usePortalClass();
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const { ep } = useElementClasses();
  const factors = factorsOf(flow.signIn, "second");
  const available: Array<{ strategy: string; label: string }> =
    factors.length > 0
      ? factors.map((factor) => ({
          strategy: factor.strategy,
          label: labelForSecondFactor(t, factor.strategy),
        }))
      : [{ strategy: "totp", label: labelForSecondFactor(t, "totp") }];

  const [strategy, setStrategy] = useState(() => available[0]?.strategy ?? "totp");
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(true);
  const trustEnabled = environment.trustedDevices.enabled;

  const changeStrategy = async (next: string) => {
    setStrategy(next);
    setCode("");
    flow.setError(null);
    if (next === "phone_code" || next === "email_code") {
      const factor = factors.find((candidate) => candidate.strategy === next);
      await flow.prepareSecondFactor(next, {
        ...(factor?.phone_number_id ? { phoneNumberId: factor.phone_number_id } : {}),
        ...(factor?.email_address_id ? { emailAddressId: factor.email_address_id } : {}),
      });
    }
  };

  const submit = () => {
    void flow.attemptSecondFactor({
      strategy,
      code,
      ...(trustEnabled && trust ? { trustDevice: true } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      {available.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-medium">{t("signIn.secondFactor.useAnotherMethod")}</Label>
          <Select value={strategy} onValueChange={(next) => void changeStrategy(next)}>
            <SelectTrigger aria-label={t("signIn.secondFactor.useAnotherMethod")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={portalClass()}>
              {available.map((option) => (
                <SelectItem key={option.strategy} value={option.strategy}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">{labelForSecondFactor(t, strategy)}</p>
      {strategy === "backup_code" ? (
        <Input
          value={code}
          onChange={(event) => setCode(event.target.value.trim())}
          autoComplete="one-time-code"
          aria-label={t("formFieldLabel__code")}
          placeholder={t("signIn.secondFactor.backupCode")}
          autoFocus
          disabled={flow.busy}
        />
      ) : (
        <OtpField
          value={code}
          onChange={setCode}
          onComplete={(value) =>
            void flow.attemptSecondFactor({
              strategy,
              code: value,
              ...(trustEnabled && trust ? { trustDevice: true } : {}),
            })
          }
          label={t("formFieldLabel__code")}
          disabled={flow.busy}
          autoFocus
        />
      )}
      {trustEnabled ? (
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <Label htmlFor="trust-this-browser" className="text-sm font-normal">
            {t("signIn.secondFactor.trustDevice", { days: environment.trustedDevices.days })}
          </Label>
          <input
            id="trust-this-browser"
            type="checkbox"
            className="size-4 accent-foreground"
            checked={trust}
            onChange={(event) => setTrust(event.target.checked)}
            disabled={flow.busy}
          />
        </div>
      ) : null}
      <Button
        type="button"
        disabled={flow.busy || code.length < (strategy === "backup_code" ? 8 : 6)}
        {...ep("formButtonPrimary", "w-full")}
        onClick={submit}
      >
        {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {t("signIn.secondFactor.action")}
      </Button>
      <div className="flex justify-center">
        <LinkButton label={t("signIn.chooseStrategy.title")} onClick={() => flow.go("choose-strategy")} />
      </div>
    </div>
  );
}

function labelForSecondFactor(t: TranslateFn, strategy: string): string {
  if (strategy === "phone_code") return t("signIn.secondFactor.methodPhoneCode");
  if (strategy === "email_code") return t("signIn.secondFactor.methodEmailCode");
  if (strategy === "backup_code") return t("signIn.secondFactor.methodBackupCode");
  return t("signIn.secondFactor.methodTotp");
}
