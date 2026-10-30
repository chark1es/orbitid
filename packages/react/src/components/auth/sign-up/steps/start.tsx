import { useState } from "react";
import { useForm } from "react-hook-form";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Input,
  Label,
  cn,
} from "@orbitid/ui";
import { Loader2Icon } from "lucide-react";
import { useAuthRuntime } from "../../_shared/w6";
import { useElementClasses } from "../../_shared/appearance";
import { CaptchaWidget } from "../../_shared/captcha";
import { Field } from "../../_shared/field";
import { FormError } from "../../_shared/form-error";
import { PasswordField, passwordMeetsPolicy } from "../../_shared/password-field";
import { PhoneInput } from "../../_shared/phone-input";
import { SocialButtons } from "../../_shared/social-buttons";
import { type SignUpStepProps, type StartFormValues, Divider, LegalConsent } from "./shared";

export function SignUpStartStep({ flow, props }: SignUpStepProps) {
  const runtime = useAuthRuntime();
  const { t, environment, navigate } = runtime;
  const { el, appearance } = useElementClasses();
  const { attributes } = environment;
  const form = useForm<StartFormValues>({
    defaultValues: {
      emailAddress: flow.initialForm.emailAddress,
      phoneNumber: flow.initialForm.phoneNumber,
      username: flow.initialForm.username,
      firstName: flow.initialForm.firstName,
      lastName: flow.initialForm.lastName,
      legalAccepted: false,
    },
    mode: "onSubmit",
  });

  const [password, setPassword] = useState(flow.initialForm.password);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [legalError, setLegalError] = useState(false);

  const socialAtTop = appearance.layout?.socialButtonsPlacement !== "bottom";
  const social =
    environment.social.length > 0 ? (
      <SocialButtons
        providers={environment.social}
        disabled={flow.busy}
        onSelect={(provider) => void flow.authenticateWithRedirect(provider.strategy)}
      />
    ) : null;

  const submit = form.handleSubmit(async (values) => {
    if (environment.signUp.legalConsentRequired && !values.legalAccepted) {
      setLegalError(true);
      return;
    }
    let invalid = false;
    const requireField = (field: "emailAddress" | "phoneNumber" | "username" | "firstName" | "lastName", missing: boolean) => {
      if (!missing) return;
      invalid = true;
      form.setError(field, { message: t("formFieldError__required") });
    };
    requireField("emailAddress", attributes.email_address.required && !values.emailAddress.trim());
    requireField("phoneNumber", attributes.phone_number.required && !values.phoneNumber.trim());
    requireField("username", attributes.username.required && !values.username.trim());
    requireField("firstName", attributes.first_name.required && !values.firstName.trim());
    requireField("lastName", attributes.last_name.required && !values.lastName.trim());
    if (attributes.password.enabled && (attributes.password.required || password.length > 0) && !passwordMeetsPolicy(password, environment.password)) {
      invalid = true;
      setPasswordError(
        t("formFieldError__passwordLength", {
          min: environment.password.minLength,
          max: environment.password.maxLength,
        }),
      );
    } else {
      setPasswordError(null);
    }
    if (invalid) return;

    const payload: Record<string, unknown> = {};
    if (attributes.email_address.enabled && values.emailAddress.trim()) payload.emailAddress = values.emailAddress.trim();
    if (attributes.phone_number.enabled && values.phoneNumber.trim()) payload.phoneNumber = values.phoneNumber.trim();
    if (attributes.username.enabled && values.username.trim()) payload.username = values.username.trim();
    if (attributes.first_name.enabled && values.firstName.trim()) payload.firstName = values.firstName.trim();
    if (attributes.last_name.enabled && values.lastName.trim()) payload.lastName = values.lastName.trim();
    if (attributes.password.enabled && password) payload.password = password;
    if (environment.signUp.legalConsentRequired) payload.legalAccepted = values.legalAccepted;
    await flow.create(payload);
  });

  return (
    <div className="flex flex-col gap-5">
      <FormError message={flow.error} />
      {flow.transfer ? (
        <Alert>
          <AlertTitle>{t("signIn.transfer.title")}</AlertTitle>
          <AlertDescription>{t("signIn.transfer.message", { identifier: flow.initialForm.emailAddress })}</AlertDescription>
        </Alert>
      ) : null}
      {flow.ticket ? (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("signUp.ticket.label")}: <span className="font-mono">{flow.ticket}</span>
        </p>
      ) : null}
      {social && socialAtTop ? (
        <>
          {social}
          <Divider />
        </>
      ) : null}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {attributes.first_name.enabled || attributes.last_name.enabled ? (
          <div className="grid grid-cols-2 gap-3">
            {attributes.first_name.enabled ? (
              <Field
                control={form.control}
                name="firstName"
                label={t("formFieldLabel__firstName")}
                required={attributes.first_name.required}
              >
                {(field) => (
                  <Input
                    id={field.id}
                    aria-invalid={field["aria-invalid"]}
                    aria-describedby={field["aria-describedby"]}
                    name={field.name}
                    value={String(field.value ?? "")}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    autoComplete="given-name"
                    placeholder={t("formFieldPlaceholder__firstName")}
                    disabled={flow.busy}
                    className={cn(el("formFieldInput"))}
                  />
                )}
              </Field>
            ) : null}
            {attributes.last_name.enabled ? (
              <Field
                control={form.control}
                name="lastName"
                label={t("formFieldLabel__lastName")}
                required={attributes.last_name.required}
              >
                {(field) => (
                  <Input
                    id={field.id}
                    aria-invalid={field["aria-invalid"]}
                    aria-describedby={field["aria-describedby"]}
                    name={field.name}
                    value={String(field.value ?? "")}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    autoComplete="family-name"
                    placeholder={t("formFieldPlaceholder__lastName")}
                    disabled={flow.busy}
                    className={cn(el("formFieldInput"))}
                  />
                )}
              </Field>
            ) : null}
          </div>
        ) : null}
        {attributes.username.enabled ? (
          <Field
            control={form.control}
            name="username"
            label={t("formFieldLabel__username")}
            required={attributes.username.required}
            description={t("formFieldHint__username", {
              min: environment.username.minLength,
              max: environment.username.maxLength,
            })}
          >
            {(field) => (
              <Input
                id={field.id}
                aria-invalid={field["aria-invalid"]}
                aria-describedby={field["aria-describedby"]}
                name={field.name}
                value={String(field.value ?? "")}
                onChange={field.onChange}
                onBlur={field.onBlur}
                autoComplete="username"
                placeholder={t("formFieldPlaceholder__username")}
                disabled={flow.busy}
                className={cn(el("formFieldInput"))}
              />
            )}
          </Field>
        ) : null}
        {attributes.email_address.enabled ? (
          <Field
            control={form.control}
            name="emailAddress"
            label={t("formFieldLabel__emailAddress")}
            required={attributes.email_address.required}
          >
            {(field) => (
              <Input
                id={field.id}
                aria-invalid={field["aria-invalid"]}
                aria-describedby={field["aria-describedby"]}
                name={field.name}
                value={String(field.value ?? "")}
                onChange={field.onChange}
                onBlur={field.onBlur}
                type="email"
                autoComplete="email"
                placeholder={t("formFieldPlaceholder__emailAddress")}
                disabled={flow.busy}
                className={cn(el("formFieldInput"))}
              />
            )}
          </Field>
        ) : null}
        {attributes.phone_number.enabled ? (
          <Field
            control={form.control}
            name="phoneNumber"
            label={t("formFieldLabel__phoneNumber")}
            required={attributes.phone_number.required}
          >
            {(field) => (
              <PhoneInput
                id={field.id}
                aria-invalid={field["aria-invalid"]}
                aria-describedby={field["aria-describedby"]}
                value={String(field.value ?? "")}
                onChange={field.onChange}
                onBlur={field.onBlur}
                name={field.name}
                disabled={flow.busy}
              />
            )}
          </Field>
        ) : null}
        {attributes.password.enabled ? (
          <PasswordField
            label={t("formFieldLabel__password")}
            value={password}
            onChange={(next) => {
              setPassword(next);
              setPasswordError(null);
            }}
            autoComplete="new-password"
            required={attributes.password.required}
            disabled={flow.busy}
            showStrength
            showRequirements
            settings={environment.password}
            error={passwordError}
          />
        ) : null}
        {environment.signUp.legalConsentRequired ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2">
              <Checkbox
                id="legal-accepted"
                checked={form.watch("legalAccepted")}
                onCheckedChange={(checked) => {
                  form.setValue("legalAccepted", checked === true);
                  setLegalError(false);
                }}
                aria-describedby={legalError ? "legal-error" : undefined}
                className="mt-0.5"
              />
              <Label htmlFor="legal-accepted" className="font-normal leading-snug">
                <LegalConsent />
              </Label>
            </div>
            {legalError ? (
              <p id="legal-error" role="alert" className="text-xs text-destructive">
                {t("formFieldError__required")}
              </p>
            ) : null}
          </div>
        ) : null}
        {environment.captcha.enabled ? (
          <CaptchaWidget onToken={flow.setCaptchaToken} />
        ) : null}
        <Button
          type="submit"
          disabled={flow.busy}
          className={cn("w-full", el("formButtonPrimary"))}
        >
          {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
          {t("signUp.start.action")}
        </Button>
      </form>
      {social && !socialAtTop ? (
        <>
          <Divider />
          {social}
        </>
      ) : null}
      <p className="flex items-center justify-center gap-1 text-sm">
        <span className="text-muted-foreground">{t("signUp.start.haveAccount")}</span>
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 font-medium"
          onClick={() => navigate(props.signInUrl ?? (typeof runtime.orbit.buildSignInUrl === "function" ? runtime.orbit.buildSignInUrl() : "/sign-in"))}
        >
          {t("signUp.start.signInAction")}
        </Button>
      </p>
    </div>
  );
}
