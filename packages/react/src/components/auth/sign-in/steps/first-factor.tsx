import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Button, cn } from "@orbitid/ui";
import { Loader2Icon, MailIcon } from "lucide-react";
import { useAuthRuntime } from "../../_shared/w6";
import { useElementClasses } from "../../_shared/appearance";
import { FormError } from "../../_shared/form-error";
import { Field } from "../../_shared/field";
import { OtpField } from "../../_shared/otp-field";
import { PasswordInput } from "../../_shared/password-field";
import { ResendButton } from "../../_shared/resend-button";
import { IdentifierPreview, LinkButton, factorIdentifier, type StepProps } from "./shared";

export function PasswordStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const form = useForm<{ password: string }>({ defaultValues: { password: "" }, mode: "onSubmit" });

  const submit = form.handleSubmit(async (values) => {
    await flow.attemptFirstFactor({ strategy: "password", password: values.password });
  });

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      {flow.notice ? (
        <div
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
        >
          {flow.notice}
        </div>
      ) : null}
      <IdentifierPreview value={flow.identifier} onEdit={() => flow.go("start")} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field control={form.control} name="password" label={t("formFieldLabel__password")} required>
          {(field) => (
            <PasswordInput
              id={field.id}
              aria-invalid={field["aria-invalid"]}
              aria-describedby={field["aria-describedby"]}
              value={field.value}
              onChange={field.onChange}
              onBlur={field.onBlur}
              name={field.name}
              autoComplete="current-password"
              placeholder={t("formFieldPlaceholder__password")}
              autoFocus
              disabled={flow.busy}
            />
          )}
        </Field>
        <Button type="submit" disabled={flow.busy} className={cn("w-full", el("formButtonPrimary"))}>
          {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t("signIn.password.action")}
        </Button>
      </form>
      <div className="flex flex-col items-center gap-2">
        <LinkButton label={t("signIn.password.forgotPassword")} onClick={() => flow.go("forgot-password")} />
        <LinkButton label={t("signIn.password.useAnotherMethod")} onClick={() => flow.go("choose-strategy")} />
      </div>
    </div>
  );
}

export function EmailCodeStep({ flow }: StepProps) {
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
        onComplete={(value) => void flow.attemptFirstFactor({ strategy: "email_code", code: value })}
        label={t("formFieldLabel__code")}
        disabled={flow.busy}
        autoFocus
      />
      <Button
        type="button"
        disabled={flow.busy || code.length < 6}
        className={cn("w-full", el("formButtonPrimary"))}
        onClick={() => void flow.attemptFirstFactor({ strategy: "email_code", code })}
      >
        {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {t("signIn.emailCode.action")}
      </Button>
      <ResendButton
        onResend={() => flow.prepareFirstFactor("email_code").then(() => undefined)}
        label={t("signIn.emailCode.resend")}
        onError={(error) => flow.setError(error instanceof Error ? error.message : t("errors.unexpected"))}
        disabled={flow.busy}
      />
      <div className="flex justify-center">
        <LinkButton label={t("signIn.start.useAnotherMethod")} onClick={() => flow.go("choose-strategy")} />
      </div>
    </div>
  );
}

export function PhoneCodeStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const [code, setCode] = useState("");
  const identifier = factorIdentifier(flow.signIn) || flow.identifier;

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <p className="text-center text-sm text-muted-foreground">{t("signIn.phoneCode.subtitle", { identifier })}</p>
      <OtpField
        value={code}
        onChange={setCode}
        onComplete={(value) => void flow.attemptFirstFactor({ strategy: "phone_code", code: value })}
        label={t("formFieldLabel__code")}
        disabled={flow.busy}
        autoFocus
      />
      <Button
        type="button"
        disabled={flow.busy || code.length < 6}
        className={cn("w-full", el("formButtonPrimary"))}
        onClick={() => void flow.attemptFirstFactor({ strategy: "phone_code", code })}
      >
        {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
        {t("signIn.phoneCode.action")}
      </Button>
      <ResendButton
        onResend={() => flow.prepareFirstFactor("phone_code").then(() => undefined)}
        label={t("signIn.phoneCode.resend")}
        onError={(error) => flow.setError(error instanceof Error ? error.message : t("errors.unexpected"))}
        disabled={flow.busy}
      />
      <div className="flex justify-center">
        <LinkButton label={t("signIn.start.useAnotherMethod")} onClick={() => flow.go("choose-strategy")} />
      </div>
    </div>
  );
}

export function EmailLinkStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const identifier = factorIdentifier(flow.signIn) || flow.identifier;

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
        {t("signIn.emailLink.subtitle", { identifier })}
      </p>
      <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground" aria-live="polite">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        {t("signIn.emailLink.waiting")}
      </div>
      <Button type="button" variant="outline" disabled={flow.busy} onClick={() => void flow.pollCompletion()}>
        {t("signIn.emailLink.iAlreadyClicked")}
      </Button>
      <ResendButton
        onResend={() => flow.prepareFirstFactor("email_link").then(() => undefined)}
        label={t("signIn.emailLink.resend")}
        onError={(error) => flow.setError(error instanceof Error ? error.message : t("errors.unexpected"))}
        disabled={flow.busy}
      />
      <div className="flex justify-center">
        <LinkButton label={t("signIn.start.useAnotherMethod")} onClick={() => flow.go("choose-strategy")} />
      </div>
    </div>
  );
}
