import { useEffect } from "react";
import { AuthAppearanceScope } from "../_shared/appearance";
import { AuthCard } from "../_shared/auth-card";
import { useAuthRuntime } from "../_shared/w6";
import type { TranslateFn } from "../_shared/w6";
import { pickSignIn } from "../_shared/api";
import type { SignInProps } from "../_shared/types";
import { useStep } from "../_shared/use-step";
import { AuthLoadingScreen } from "../_shared/loading";
import { SIGN_IN_STEPS, signInSlug, signInStepFromStatus, useSignInFlow, type SignInStep } from "./flow";
import { TwoFactorSetup } from "../setup-two-factor";
import {
  ChooseStrategyStep,
  EmailCodeStep,
  EmailLinkStep,
  EnterpriseSsoStep,
  ForgotPasswordStep,
  PasswordStep,
  PhoneCodeStep,
  ResetPasswordCodeStep,
  ResetPasswordStep,
  SecondFactorStep,
  SsoCallbackStep,
  StartStep,
  SuccessStep,
  TransferStep,
} from "./steps";

function SignInInner(props: SignInProps) {
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const initialStep = signInStepFromStatus(pickSignIn(runtime.orbit, null));
  const { step, setStep } = useStep<SignInStep>({
    routing: props.routing ?? "path",
    path: props.path ?? "/sign-in",
    steps: SIGN_IN_STEPS,
    initialStep,
    slugFor: signInSlug,
  });
  const flow = useSignInFlow(props, step, setStep);
  const pendingSession = runtime.session?.status === "pending";

  // A pending session can only enrol a second factor, whether sign-in just created it or the page reloaded.
  useEffect(() => {
    if (runtime.loaded && pendingSession && !flow.setupCompleted && step !== "setup-mfa") {
      setStep("setup-mfa");
    }
  }, [runtime.loaded, pendingSession, flow.setupCompleted, step, setStep]);

  if (!runtime.loaded) return <AuthLoadingScreen />;

  const copy = stepCopy(step, t, environment.app.name);

  return (
    <div className="flex w-full items-center justify-center px-4 py-6">
      <AuthCard title={copy.title} subtitle={copy.subtitle}>
        {step === "start" ? <StartStep flow={flow} props={props} /> : null}
        {step === "password" ? <PasswordStep flow={flow} props={props} /> : null}
        {step === "email-code" ? <EmailCodeStep flow={flow} props={props} /> : null}
        {step === "email-link" ? <EmailLinkStep flow={flow} props={props} /> : null}
        {step === "phone-code" ? <PhoneCodeStep flow={flow} props={props} /> : null}
        {step === "forgot-password" ? <ForgotPasswordStep flow={flow} props={props} /> : null}
        {step === "reset-password-code" ? <ResetPasswordCodeStep flow={flow} props={props} /> : null}
        {step === "reset-password" ? <ResetPasswordStep flow={flow} props={props} /> : null}
        {step === "choose-strategy" ? <ChooseStrategyStep flow={flow} props={props} /> : null}
        {step === "second-factor" ? <SecondFactorStep flow={flow} props={props} /> : null}
        {step === "enterprise-sso" ? <EnterpriseSsoStep flow={flow} props={props} /> : null}
        {step === "transfer" ? <TransferStep flow={flow} props={props} /> : null}
        {step === "sso-callback" ? <SsoCallbackStep flow={flow} props={props} /> : null}
        {step === "setup-mfa" ? (
          <TwoFactorSetup
            sessionId={flow.pendingSessionId ?? runtime.session?.id ?? null}
            onComplete={flow.completeSetup}
          />
        ) : null}
        {step === "success" ? <SuccessStep flow={flow} props={props} /> : null}
      </AuthCard>
    </div>
  );
}

function stepCopy(
  step: SignInStep,
  t: TranslateFn,
  applicationName: string,
): { title: string; subtitle?: string } {
  switch (step) {
    case "start":
      return {
        title: t("signIn.start.title", { applicationName }),
        subtitle: t("signIn.start.subtitle"),
      };
    case "password":
      return { title: t("signIn.password.title") };
    case "email-code":
      return { title: t("signIn.emailCode.title") };
    case "email-link":
      return { title: t("signIn.emailLink.title") };
    case "phone-code":
      return { title: t("signIn.phoneCode.title") };
    case "forgot-password":
      return {
        title: t("signIn.forgotPassword.title"),
        subtitle: t("signIn.forgotPassword.subtitle"),
      };
    case "reset-password-code":
      return { title: t("signIn.emailCode.title") };
    case "reset-password":
      return {
        title: t("signIn.resetPassword.title"),
        subtitle: t("signIn.resetPassword.subtitle"),
      };
    case "choose-strategy":
      return {
        title: t("signIn.chooseStrategy.title"),
        subtitle: t("signIn.chooseStrategy.subtitle"),
      };
    case "second-factor":
      return {
        title: t("signIn.secondFactor.title"),
        subtitle: t("signIn.secondFactor.subtitle"),
      };
    case "enterprise-sso":
      return {
        title: t("signIn.enterpriseSso.title"),
        subtitle: t("signIn.enterpriseSso.subtitle"),
      };
    case "transfer":
      return { title: t("signIn.transfer.title") };
    case "sso-callback":
      return { title: t("signIn.ssoCallback.processing") };
    case "setup-mfa":
      return {
        title: t("signIn.setupTwoFactor.title"),
        subtitle: t("signIn.setupTwoFactor.subtitle"),
      };
    case "success":
      return { title: t("signIn.success.title") };
  }
}

export function SignIn(props: SignInProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <SignInInner {...props} />
    </AuthAppearanceScope>
  );
}
