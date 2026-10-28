import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Input,
  Label,
  Separator,
  cn,
} from "@orbitid/ui";
import { ArrowLeftIcon, CheckCircle2Icon, Loader2Icon, MailIcon } from "lucide-react";
import { useAuthRuntime } from "../_shared/w6";
import { useElementClasses } from "../_shared/appearance";
import { CaptchaWidget } from "../_shared/captcha";
import { Field } from "../_shared/field";
import { FormError } from "../_shared/form-error";
import { OtpField } from "../_shared/otp-field";
import { PasswordField, passwordMeetsPolicy } from "../_shared/password-field";
import { PhoneInput } from "../_shared/phone-input";
import { ResendButton } from "../_shared/resend-button";
import { SocialButtons } from "../_shared/social-buttons";
import type { SignUpProps } from "../_shared/types";
import type { SignUpFlow } from "./flow";

export interface SignUpStepProps {
  flow: SignUpFlow;
  props: SignUpProps;
}

interface StartFormValues {
  emailAddress: string;
  phoneNumber: string;
  username: string;
  firstName: string;
  lastName: string;
  legalAccepted: boolean;
}

function Divider() {
  const { t } = useAuthRuntime();
  return (
    <div className="flex items-center gap-3" role="separator">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground">{t("common.or")}</span>
      <Separator className="flex-1" />
    </div>
  );
}

function LegalConsent() {
  const { t, environment } = useAuthRuntime();
  const terms = environment.app.termsUrl;
  const privacy = environment.app.privacyUrl;
  return (
    <span className="text-sm text-muted-foreground">
      {terms || privacy ? (
        <>
          {t("signUp.start.legalConsentPrefix")}{" "}
          {terms ? (
            <a href={terms} className="font-medium text-foreground underline underline-offset-4" rel="noreferrer">
              {t("footer.terms")}
            </a>
          ) : (
            t("footer.terms")
          )}{" "}
          {t("signUp.start.legalConsentConjunction")}{" "}
          {privacy ? (
            <a href={privacy} className="font-medium text-foreground underline underline-offset-4" rel="noreferrer">
              {t("footer.privacy")}
            </a>
          ) : (
            t("footer.privacy")
          )}
          .
        </>
      ) : (
        t("signUp.start.legalConsentPlain")
      )}
    </span>
  );
}

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

export function VerifyCodeStep({ flow, strategy }: SignUpStepProps & { strategy: "email_code" | "phone_code" }) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
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
        className={cn("w-full", el("formButtonPrimary"))}
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

const FIELD_LABELS: Record<string, string> = {
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
      <CheckCircle2Icon className="size-10 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <p className="text-sm font-medium">{t("signUp.success.title", { applicationName: environment.app.name })}</p>
      <p className="text-sm text-muted-foreground">{t("signUp.success.message")}</p>
      <Button type="button" className="w-full" onClick={() => navigate(environment.app.homeUrl)}>
        {t("signUp.success.action")}
      </Button>
    </div>
  );
}
