import { useForm } from "react-hook-form";
import { Button, Input, cn } from "@orbitid/ui";
import { ArrowLeftIcon, CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useAuthRuntime } from "../../_shared/w6";
import type { TranslationKey } from "../../../../localization";
import { useElementClasses } from "../../_shared/appearance";
import { Field } from "../../_shared/field";
import { FormError } from "../../_shared/form-error";
import { passwordMeetsPolicy } from "../../_shared/password-field";
import { PhoneInput } from "../../_shared/phone-input";
import { type SignUpStepProps } from "./shared";

const FIELD_LABELS: Record<string, TranslationKey> = {
  email_address: "formFieldLabel__emailAddress",
  phone_number: "formFieldLabel__phoneNumber",
  username: "formFieldLabel__username",
  first_name: "formFieldLabel__firstName",
  last_name: "formFieldLabel__lastName",
  password: "formFieldLabel__password",
};

export function ContinueStep({ flow }: SignUpStepProps) {
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const { el } = useElementClasses();
  const missing = flow.signUp?.missing_fields ?? [];
  const fields = missing.filter((field) => field !== "legal_accepted" && FIELD_LABELS[field]);

  type Values = Record<string, string>;
  const form = useForm<Values>({
    defaultValues: {
      email_address: flow.signUp?.email_address ?? flow.initialForm.emailAddress,
      phone_number: flow.signUp?.phone_number ?? flow.initialForm.phoneNumber,
      username: flow.signUp?.username ?? flow.initialForm.username,
      first_name: flow.signUp?.first_name ?? flow.initialForm.firstName,
      last_name: flow.signUp?.last_name ?? flow.initialForm.lastName,
      password: "",
    },
  });

  const submit = form.handleSubmit(async (values) => {
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field]?.trim();
      if (!value) continue;
      if (field === "email_address") payload.emailAddress = value;
      else if (field === "phone_number") payload.phoneNumber = value;
      else if (field === "username") payload.username = value;
      else if (field === "first_name") payload.firstName = value;
      else if (field === "last_name") payload.lastName = value;
      else if (field === "password") {
        if (!passwordMeetsPolicy(value, environment.password)) {
          form.setError(field, { message: t("formFieldError__passwordLength", {
            min: environment.password.minLength,
            max: environment.password.maxLength,
          }) });
          return;
        }
        payload.password = value;
      }
    }
    await flow.update(payload);
  });

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {fields.map((field) =>
          field === "password" ? (
            <Field
              key={field}
              control={form.control}
              name={field}
              label={t(FIELD_LABELS[field]!)}
              required
            >
              {(controller) => (
                <Input
                  {...controller}
                  type="password"
                  autoComplete="new-password"
                  disabled={flow.busy}
                  className={cn(el("formFieldInput"))}
                />
              )}
            </Field>
          ) : field === "phone_number" ? (
            <Field key={field} control={form.control} name={field} label={t(FIELD_LABELS[field]!)} required>
              {(controller) => (
                <PhoneInput
                  id={controller.id}
                  value={controller.value}
                  onChange={controller.onChange}
                  onBlur={controller.onBlur}
                  name={controller.name}
                  disabled={flow.busy}
                />
              )}
            </Field>
          ) : (
            <Field key={field} control={form.control} name={field} label={t(FIELD_LABELS[field]!)} required>
              {(controller) => (
                <Input
                  {...controller}
                  type={field === "email_address" ? "email" : "text"}
                  disabled={flow.busy}
                  className={cn(el("formFieldInput"))}
                />
              )}
            </Field>
          ),
        )}
        {fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("signUp.continue.subtitle")}</p>
        ) : null}
        <Button type="submit" disabled={flow.busy} className={cn("w-full", el("formButtonPrimary"))}>
          {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t("signUp.continue.action")}
        </Button>
      </form>
      <div className="flex justify-center">
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => flow.go("start")}>
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t("common.back")}
        </Button>
      </div>
    </div>
  );
}

export function SignUpSuccessStep() {
  const runtime = useAuthRuntime();
  const { t, environment, navigate } = runtime;
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <CheckCircle2Icon className="size-10 text-go" aria-hidden="true" />
      <p className="text-sm font-medium">{t("signUp.success.title", { applicationName: environment.app.name })}</p>
      <p className="text-sm text-muted-foreground">{t("signUp.success.message")}</p>
      <Button type="button" className="w-full" onClick={() => navigate(environment.app.homeUrl)}>
        {t("signUp.success.action")}
      </Button>
    </div>
  );
}
