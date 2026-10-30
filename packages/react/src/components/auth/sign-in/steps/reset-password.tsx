import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button, Input, Label, Switch, cn } from "@orbitid/ui";
import { Loader2Icon } from "lucide-react";
import { useAuthRuntime } from "../../_shared/w6";
import { useElementClasses } from "../../_shared/appearance";
import { FormError } from "../../_shared/form-error";
import { Field } from "../../_shared/field";
import { OtpField } from "../../_shared/otp-field";
import { PasswordField, passwordMeetsPolicy } from "../../_shared/password-field";
import { ResendButton } from "../../_shared/resend-button";
import { LinkButton, factorIdentifier, type StepProps } from "./shared";

export function ForgotPasswordStep({ flow }: StepProps) {
  const { t, environment } = useAuthRuntime();
  const { el } = useElementClasses();
  const form = useForm<{ email: string }>({
    defaultValues: { email: flow.identifierDraft },
    mode: "onSubmit",
  });
  const canResetPassword = environment.attributes.password.enabled && environment.attributes.email_address.enabled;

  // Password reset is email based. Without it there is nothing to ask for, so do not show an email field.
  useEffect(() => {
    if (!canResetPassword) flow.go("start");
  }, [canResetPassword]);
  if (!canResetPassword) return null;

  const submit = form.handleSubmit(async (values) => {
    const identifier = values.email.trim();
    if (!identifier) {
      form.setError("email", { message: t("formFieldError__required") });
      return;
    }
    flow.setIdentifierDraft(identifier);
    const created = await flow.create(
      { identifier, strategy: "reset_password_email_code" },
      { route: false },
    );
    if (!created) return;
    const prepared = await flow.prepareFirstFactor("reset_password_email_code");
    if (prepared) flow.go("reset-password-code");
  });

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field control={form.control} name="email" label={t("formFieldLabel__emailAddress")} required>
          {(field) => (
            <Input
              {...field}
              type="email"
              autoComplete="email"
              placeholder={t("formFieldPlaceholder__emailAddress")}
              autoFocus
              disabled={flow.busy}
              className={cn(el("formFieldInput"))}
            />
          )}
        </Field>
        <Button type="submit" disabled={flow.busy} className={cn("w-full", el("formButtonPrimary"))}>
          {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t("signIn.forgotPassword.action")}
        </Button>
      </form>
      <div className="flex justify-center">
        <LinkButton label={t("signIn.forgotPassword.back")} onClick={() => flow.go("start")} />
      </div>
    </div>
  );
}

export function ResetPasswordCodeStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const [code, setCode] = useState("");
  const identifier = factorIdentifier(flow.signIn) || flow.identifier;

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <p className="text-center text-sm text-muted-foreground">
        {t("signIn.emailCode.subtitle", { identifier })}
      </p>
      <OtpField
        value={code}
        onChange={setCode}
        onComplete={(value) =>
          void flow.attemptFirstFactor({ strategy: "reset_password_email_code", code: value })
        }
        label={t("formFieldLabel__code")}
        disabled={flow.busy}
        autoFocus
      />
      <Button
        type="button"
        disabled={flow.busy || code.length < 6}
        className={cn("w-full", el("formButtonPrimary"))}
        onClick={() => void flow.attemptFirstFactor({ strategy: "reset_password_email_code", code })}
      >
        {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {t("common.verify")}
      </Button>
      <ResendButton
        onResend={() => flow.prepareFirstFactor("reset_password_email_code").then(() => undefined)}
        onError={(error) => flow.setError(error instanceof Error ? error.message : t("errors.unexpected"))}
        disabled={flow.busy}
      />
    </div>
  );
}

export function ResetPasswordStep({ flow }: StepProps) {
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const { el } = useElementClasses();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const mismatch = confirm.length > 0 && password !== confirm;
  const policyMet = passwordMeetsPolicy(password, environment.password);

  const submit = async () => {
    if (mismatch || !policyMet) return;
    await flow.resetPassword({ password, signOutOtherSessions: signOutOthers });
  };

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <p className="text-sm text-muted-foreground">{t("signIn.resetPassword.subtitle")}</p>
      <PasswordField
        label={t("common.newPassword")}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        autoFocus
        disabled={flow.busy}
        showStrength
        showRequirements
        settings={environment.password}
        error={password.length > 0 && !policyMet ? t("formFieldError__passwordLength", { min: environment.password.minLength, max: environment.password.maxLength }) : null}
      />
      <PasswordField
        label={t("common.confirmPassword")}
        value={confirm}
        onChange={setConfirm}
        autoComplete="new-password"
        disabled={flow.busy}
        error={mismatch ? t("common.passwordsDoNotMatch") : null}
      />
      <div className="flex items-center justify-between gap-3 rounded-md border p-3">
        <Label htmlFor="sign-out-others" className="text-sm font-normal">
          {t("signIn.resetPassword.signOutOtherDevices")}
        </Label>
        <Switch id="sign-out-others" checked={signOutOthers} onCheckedChange={setSignOutOthers} />
      </div>
      <Button
        type="button"
        disabled={flow.busy || mismatch || !policyMet}
        className={cn("w-full", el("formButtonPrimary"))}
        onClick={() => void submit()}
      >
        {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {t("signIn.resetPassword.action")}
      </Button>
    </div>
  );
}
