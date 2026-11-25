import { Component, useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription, AlertTitle, Button, Input, cn } from "@orbitid/ui";
import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { AuthenticateWithRedirectCallback } from "../../../../control";
import { signUpUrlFor } from "../flow";
import { useAuthRuntime } from "../../_shared/w6";
import { useComponentElements } from "../../_shared/appearance";
import { FormError } from "../../_shared/form-error";
import { Field } from "../../_shared/field";
import { LinkButton, type StepProps } from "./shared";

export function EnterpriseSsoStep({ flow }: StepProps) {
  const { t } = useAuthRuntime();
  const { ep } = useComponentElements();
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
      <form onSubmit={submit} {...ep("form", "flex flex-col gap-4")} noValidate>
        <Field control={form.control} name="email" label={t("formFieldLabel__emailAddress")} required>
          {(field) => (
            <Input
              {...field}
              type="email"
              autoComplete="email"
              placeholder={t("formFieldPlaceholder__emailAddress")}
              autoFocus
              disabled={flow.busy}
              {...ep("formFieldInput")}
            />
          )}
        </Field>
        <Button type="submit" disabled={flow.busy} {...ep("formButtonPrimary", "w-full")}>
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
      <CheckCircle2Icon className="size-10 text-go" aria-hidden="true" />
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
