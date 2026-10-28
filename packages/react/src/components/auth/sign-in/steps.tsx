import { Component, useEffect, useRef, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  cn,
} from "@orbitid/ui";
import {
  ArrowLeftIcon,
  Building2Icon,
  CheckCircle2Icon,
  FingerprintIcon,
  KeyRoundIcon,
  LinkIcon,
  Loader2Icon,
  MailIcon,
  SmartphoneIcon,
} from "lucide-react";
import { factorsOf } from "../_shared/api";
import { AuthenticateWithRedirectCallback } from "../../../control";
import { signUpUrlFor } from "./flow";
import { useAuthRuntime } from "../_shared/w6";
import { useElementClasses } from "../_shared/appearance";
import { FormError } from "../_shared/form-error";
import { Field } from "../_shared/field";
import { OtpField } from "../_shared/otp-field";
import { PasswordField, PasswordInput, passwordMeetsPolicy } from "../_shared/password-field";
import { ProviderIcon } from "../_shared/provider-icon";
import { ResendButton } from "../_shared/resend-button";
import { SocialButtons } from "../_shared/social-buttons";
import type { EnvironmentView } from "../_shared/environment";
import type { SignInProps, SignInResource } from "../_shared/types";
import type { OrbitInstance } from "../_shared/w6";
import type { SignInFlow } from "./flow";

export interface StepProps {
  flow: SignInFlow;
  props: SignInProps;
}

function Divider() {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  return (
    <div className="flex items-center gap-3" role="separator">
      <Separator className={cn("flex-1", el("dividerLine"))} />
      <span className={cn("text-xs text-muted-foreground", el("dividerText"))}>{t("common.or")}</span>
      <Separator className={cn("flex-1", el("dividerLine"))} />
    </div>
  );
}

function FooterSwitch({
  text,
  actionLabel,
  onClick,
}: {
  text: string;
  actionLabel: string;
  onClick: () => void;
}) {
  const { el } = useElementClasses();
  return (
    <p className={cn("flex items-center justify-center gap-1 text-sm", el("footerAction"))}>
      <span className={cn("text-muted-foreground", el("footerActionText"))}>{text}</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={onClick}
        className={cn("h-auto p-0 font-medium", el("footerActionLink"))}
      >
        {actionLabel}
      </Button>
    </p>
  );
}

function LinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="link" size="sm" onClick={onClick} className="h-auto p-0 text-sm font-medium">
      {label}
    </Button>
  );
}

function IdentifierPreview({ value, onEdit }: { value: string; onEdit: () => void }) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm",
        el("identityPreview"),
      )}
    >
      <span className={cn("truncate", el("identityPreviewText"))}>{value}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onEdit}
        className={cn("h-7 px-2 text-xs", el("identityPreviewEditButton"))}
      >
        {t("common.edit")}
      </Button>
    </div>
  );
}

function identifierLabel(
  t: (key: string) => string,
  identifiers: readonly string[],
): string {
  if (identifiers.length === 1) {
    if (identifiers[0] === "email_address") return t("formFieldLabel__emailAddress");
    if (identifiers[0] === "phone_number") return t("formFieldLabel__phoneNumber");
    if (identifiers[0] === "username") return t("formFieldLabel__username");
  }
  return t("signIn.start.identifierLabel");
}

function identifierInputType(identifiers: readonly string[]): string {
  if (identifiers.length === 1 && identifiers[0] === "email_address") return "email";
  if (identifiers.length === 1 && identifiers[0] === "phone_number") return "tel";
  return "text";
}

function identifierAutoComplete(identifiers: readonly string[]): string {
  if (identifiers.length === 1 && identifiers[0] === "phone_number") return "tel";
  if (identifiers.length === 1 && identifiers[0] === "username") return "username";
  return "username";
}

function useConditionalPasskey(flow: SignInFlow, enabled: boolean) {
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current || typeof window === "undefined") return;
    const credential = Reflect.get(window, "PublicKeyCredential");
    if (typeof credential !== "function") return;
    const isAvailable = Reflect.get(credential, "isConditionalMediationAvailable");
    if (typeof isAvailable !== "function") return;
    started.current = true;
    void (isAvailable as () => Promise<boolean>)
      .call(credential)
      .then((available) => {
        if (available) void flowRef.current.authenticateWithPasskey();
      })
      .catch(() => undefined);
  }, [enabled]);
}

export function StartStep({ flow, props }: StepProps) {
  const runtime = useAuthRuntime();
  const { environment, t, navigate, orbit } = runtime;
  const { el, appearance } = useElementClasses();
  const form = useForm<{ identifier: string }>({
    defaultValues: { identifier: flow.identifierDraft },
    mode: "onSubmit",
  });
  const hasIdentifiers = environment.identifiers.length > 0;
  const passkeyEnabled = environment.attributes.passkey.enabled;
  const socialAtTop = appearance.layout?.socialButtonsPlacement !== "bottom";

  useConditionalPasskey(flow, passkeyEnabled && environment.passkey.allowAutofill);

  const submit = form.handleSubmit(async (values) => {
    if (!values.identifier.trim()) {
      form.setError("identifier", { message: t("formFieldError__required") });
      return;
    }
    flow.setIdentifierDraft(values.identifier.trim());
    if (!hasIdentifiers) {
      flow.go("choose-strategy");
      return;
    }
    await flow.create({ identifier: values.identifier.trim() });
  });

  const social = environment.social.length > 0 ? (
    <SocialButtons
      providers={environment.social}
      disabled={flow.busy}
      lastUsedStrategy={readLastUsedStrategy(orbit)}
      onSelect={(provider) => void flow.authenticateWithRedirect(provider.strategy)}
    />
  ) : null;

  return (
    <div className="flex flex-col gap-5">
      <FormError message={flow.error} />
      {social && socialAtTop ? (
        <>
          {social}
          {hasIdentifiers || passkeyEnabled ? <Divider /> : null}
        </>
      ) : null}
      {hasIdentifiers ? (
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field
            control={form.control}
            name="identifier"
            label={identifierLabel(t, environment.identifiers)}
            required
          >
            {(field) => (
              <Input
                {...field}
                type={identifierInputType(environment.identifiers)}
                autoComplete={identifierAutoComplete(environment.identifiers)}
                placeholder={t("signIn.start.identifierPlaceholder")}
                autoFocus
                disabled={flow.busy}
                className={cn(el("formFieldInput"))}
              />
            )}
          </Field>
          <Button type="submit" disabled={flow.busy} className={cn("w-full", el("formButtonPrimary"))}>
            {flow.busy ? <Loader2Icon className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("signIn.start.actionText")}
          </Button>
        </form>
      ) : null}
      {passkeyEnabled && environment.passkey.showSignInButton ? (
        <Button
          type="button"
          variant="outline"
          className="w-full gap-2"
          disabled={flow.busy}
          onClick={() => void flow.authenticateWithPasskey()}
        >
          <FingerprintIcon className="size-4" aria-hidden="true" />
          {t("signIn.passkey.button")}
        </Button>
      ) : null}
      {social && !socialAtTop ? (
        <>
          {hasIdentifiers || passkeyEnabled ? <Divider /> : null}
          {social}
        </>
      ) : null}
      <div className="flex flex-col items-center gap-2">
        <LinkButton label={t("signIn.start.useAnotherMethod")} onClick={() => flow.go("choose-strategy")} />
        {environment.attributes.email_address.enabled || environment.attributes.password.enabled ? (
          <LinkButton label={t("signIn.start.forgotPassword")} onClick={() => flow.go("forgot-password")} />
        ) : null}
      </div>
      {(props.withSignUp ?? true) && environment.signUp.mode !== "restricted" ? (
        <FooterSwitch
          text={t("signIn.start.noAccount")}
          actionLabel={t("signIn.start.signUpAction")}
          onClick={() =>
            navigate(
              signUpUrlFor(
                props,
                undefined,
                typeof orbit.buildSignUpUrl === "function" ? orbit.buildSignUpUrl() : undefined,
              ),
            )
          }
        />
      ) : null}
    </div>
  );
}

function readLastUsedStrategy(orbit: OrbitInstance): string | null {
  const value = Reflect.get(orbit, "lastUsedStrategy");
  return typeof value === "string" ? value : null;
}

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
      <IdentifierPreview value={flow.identifier} onEdit={() => flow.go("start")} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field control={form.control} name="password" label={t("formFieldLabel__password")} required>
          {(field) => (
            <PasswordInput
              id={field.id}
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

export function ForgotPasswordStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const runtime = useAuthRuntime();
  const form = useForm<{ email: string }>({
    defaultValues: { email: flow.identifierDraft },
    mode: "onSubmit",
  });

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
              disabled={flow.busy || !runtime.environment.attributes.email_address.enabled}
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

export function ChooseStrategyStep({ flow, props }: StepProps) {
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const [identifier, setIdentifier] = useState(flow.identifierDraft);
  const factors = factorsOf(flow.signIn, "first");

  const options = buildStrategyOptions(factors, environment, t);

  const choose = async (strategy: string) => {
    let current = flow.signIn;
    if (!current) {
      const trimmed = identifier.trim();
      if (!trimmed) {
        flow.setError(t("formFieldError__required"));
        return;
      }
      flow.setIdentifierDraft(trimmed);
      current = await flow.create({ identifier: trimmed }, { route: false });
      if (!current) return;
    }
    const factor = factorsOf(current, "first").find((candidate) => candidate.strategy === strategy);
    await flow.selectFirstFactor(factor ?? { strategy });
  };

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <p className="text-sm text-muted-foreground">{t("signIn.chooseStrategy.subtitle")}</p>
      {!flow.signIn ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="choose-identifier" className="text-sm font-medium">
            {identifierLabel(t, environment.identifiers)}
          </Label>
          <Input
            id="choose-identifier"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            type={identifierInputType(environment.identifiers)}
            autoComplete={identifierAutoComplete(environment.identifiers)}
            placeholder={t("signIn.start.identifierPlaceholder")}
            disabled={flow.busy}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <Button
            key={option.strategy}
            type="button"
            variant="outline"
            className="w-full justify-start gap-2"
            disabled={flow.busy}
            data-testid={`strategy-${option.strategy}`}
            onClick={() => void choose(option.strategy)}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
            {option.description ? (
              <span className="ms-auto truncate text-xs text-muted-foreground">{option.description}</span>
            ) : null}
          </Button>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => flow.go("start")}>
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
          {t("common.back")}
        </Button>
        {(props.withSignUp ?? true) ? (
          <LinkButton label={t("signIn.start.signUpAction")} onClick={() => flow.go("start")} />
        ) : null}
      </div>
    </div>
  );
}

interface StrategyOption {
  strategy: string;
  label: string;
  description?: string;
  icon: ReactNode;
}

function buildStrategyOptions(
  factors: ReturnType<typeof factorsOf>,
  environment: EnvironmentView,
  t: (key: string, params?: Record<string, string | number>) => string,
): StrategyOption[] {
  const options: StrategyOption[] = [];
  const seen = new Set<string>();
  const factorsWithIcons = factors.length > 0 ? factors : inferFactors(environment);
  for (const factor of factorsWithIcons) {
    if (seen.has(factor.strategy)) continue;
    seen.add(factor.strategy);
    const safeIdentifier = factor.safe_identifier;
    if (factor.strategy === "password") {
      options.push({ strategy: factor.strategy, label: t("signIn.chooseStrategy.password"), icon: <KeyRoundIcon className="size-4" /> });
    } else if (factor.strategy === "email_code") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.emailCode"),
        description: safeIdentifier,
        icon: <MailIcon className="size-4" />,
      });
    } else if (factor.strategy === "email_link") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.emailLink"),
        description: safeIdentifier,
        icon: <LinkIcon className="size-4" />,
      });
    } else if (factor.strategy === "phone_code") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.phoneCode"),
        description: safeIdentifier,
        icon: <SmartphoneIcon className="size-4" />,
      });
    } else if (factor.strategy === "passkey") {
      options.push({ strategy: factor.strategy, label: t("signIn.chooseStrategy.passkey"), icon: <FingerprintIcon className="size-4" /> });
    } else if (factor.strategy === "enterprise_sso" || factor.strategy === "saml") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.enterpriseSso"),
        icon: <Building2Icon className="size-4" />,
      });
    } else if (factor.strategy === "reset_password_email_code") {
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.resetPassword"),
        description: safeIdentifier,
        icon: <KeyRoundIcon className="size-4" />,
      });
    } else if (factor.strategy.startsWith("oauth_")) {
      const providerId = factor.strategy.replace(/^oauth_/, "");
      const provider = environment.social.find((candidate) => candidate.id === providerId || candidate.strategy === factor.strategy);
      options.push({
        strategy: factor.strategy,
        label: t("signIn.chooseStrategy.oauth", { provider: provider?.name ?? providerId }),
        icon: <ProviderIcon provider={providerId} />,
      });
    }
  }
  if (options.length === 0) {
    options.push({
      strategy: "password",
      label: t("signIn.chooseStrategy.password"),
      icon: <KeyRoundIcon className="size-4" />,
    });
  }
  return options;
}

function inferFactors(environment: EnvironmentView) {
  const factors: Array<{ strategy: string; safe_identifier?: string }> = [];
  if (environment.attributes.password.enabled) factors.push({ strategy: "password" });
  if (environment.attributes.email_address.enabled) {
    const verifications = environment.attributes.email_address.verifications;
    if (verifications.includes("email_code")) factors.push({ strategy: "email_code" });
    if (verifications.includes("email_link")) factors.push({ strategy: "email_link" });
  }
  if (environment.attributes.phone_number.enabled) factors.push({ strategy: "phone_code" });
  if (environment.attributes.passkey.enabled) factors.push({ strategy: "passkey" });
  return factors;
}

export function SecondFactorStep({ flow }: StepProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const { el } = useElementClasses();
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

  const changeStrategy = async (next: string) => {
    setStrategy(next);
    setCode("");
    flow.setError(null);
    if (next === "phone_code") {
      const factor = factors.find((candidate) => candidate.strategy === "phone_code");
      await flow.prepareSecondFactor("phone_code", factor?.phone_number_id ? { phoneNumberId: factor.phone_number_id } : {});
    }
  };

  const submit = () => {
    void flow.attemptSecondFactor({ strategy, code });
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
            <SelectContent>
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
          onComplete={(value) => void flow.attemptSecondFactor({ strategy, code: value })}
          label={t("formFieldLabel__code")}
          disabled={flow.busy}
          autoFocus
        />
      )}
      <Button
        type="button"
        disabled={flow.busy || code.length < (strategy === "backup_code" ? 8 : 6)}
        className={cn("w-full", el("formButtonPrimary"))}
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

function labelForSecondFactor(t: (key: string) => string, strategy: string): string {
  if (strategy === "phone_code") return t("signIn.secondFactor.methodPhoneCode");
  if (strategy === "backup_code") return t("signIn.secondFactor.methodBackupCode");
  return t("signIn.secondFactor.methodTotp");
}

export function EnterpriseSsoStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const { el } = useElementClasses();
  const form = useForm<{ email: string }>({
    defaultValues: { email: flow.identifierDraft },
    mode: "onSubmit",
  });

  const submit = form.handleSubmit(async (values) => {
    const email = values.email.trim();
    if (!email) {
      form.setError("email", { message: t("formFieldError__required") });
      return;
    }
    flow.setIdentifierDraft(email);
    await flow.authenticateWithRedirect("enterprise_sso", { identifier: email });
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
          {t("signIn.enterpriseSso.action")}
        </Button>
      </form>
      <div className="flex justify-center">
        <LinkButton label={t("common.back")} onClick={() => flow.go("start")} />
      </div>
    </div>
  );
}

export function TransferStep({ flow, props }: StepProps) {
  const runtime = useAuthRuntime();
  const { t, navigate } = runtime;

  return (
    <div className="flex flex-col gap-4">
      <FormError message={flow.error} />
      <Alert>
        <AlertTitle>{t("signIn.transfer.title")}</AlertTitle>
        <AlertDescription>
          {t("signIn.transfer.message", { identifier: flow.identifier })}
        </AlertDescription>
      </Alert>
      <Button
        type="button"
        className="w-full"
        onClick={() =>
          navigate(
            signUpUrlFor(
              props,
              { identifier: flow.signIn?.identifier ?? flow.identifierDraft },
              typeof runtime.orbit.buildSignUpUrl === "function" ? runtime.orbit.buildSignUpUrl() : undefined,
            ),
          )
        }
      >
        {t("signIn.transfer.action")}
      </Button>
      <div className="flex justify-center">
        <LinkButton label={t("common.back")} onClick={() => flow.go("start")} />
      </div>
    </div>
  );
}

class RedirectErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return <FormError message={errorText(this.state.error)} />;
    }
    return this.props.children;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "We couldn't complete the sign in. Please try again.";
}

export function SsoCallbackStep({ flow }: StepProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const errorCode = params.get("error");
    if (errorCode) setError(params.get("error_description") || t("signIn.ssoCallback.error"));
  }, [t]);

  if (error) {
    return (
      <div className="flex flex-col gap-3">
        <FormError message={error} />
        <Button type="button" variant="outline" onClick={() => flow.go("start")}>
          {t("common.back")}
        </Button>
      </div>
    );
  }

  return (
    <RedirectErrorBoundary>
      <AuthenticateWithRedirectCallback
        signInForceRedirectUrl={flow.redirectTarget}
        signInFallbackRedirectUrl={flow.redirectTarget}
      >
        <div className="flex flex-col items-center gap-3 py-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
          <p aria-live="polite">{t("signIn.ssoCallback.processing")}</p>
        </div>
      </AuthenticateWithRedirectCallback>
    </RedirectErrorBoundary>
  );
}

export function SuccessStep({ flow }: StepProps) {
  const runtime = useAuthRuntime();
  const { t, environment, navigate } = runtime;
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <CheckCircle2Icon className="size-10 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
      <p className="text-sm font-medium">{t("signIn.success.title")}</p>
      <p className="text-sm text-muted-foreground">
        {t("signIn.success.message", { applicationName: environment.app.name })}
      </p>
      <Button
        type="button"
        className="w-full"
        onClick={() => navigate(flow.redirectTarget ?? environment.app.homeUrl)}
      >
        {t("signIn.success.action")}
      </Button>
    </div>
  );
}

export function factorIdentifier(signIn: SignInResource | null): string {
  const factors = factorsOf(signIn, "first");
  const withIdentifier = factors.find((factor) => factor.safe_identifier);
  return withIdentifier?.safe_identifier ?? signIn?.identifier ?? "";
}

export function PasskeyButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useAuthRuntime();
  return (
    <Button type="button" variant="outline" className="w-full gap-2" disabled={disabled} onClick={onClick}>
      <FingerprintIcon className="size-4" aria-hidden="true" />
      {t("signIn.passkey.button")}
    </Button>
  );
}
