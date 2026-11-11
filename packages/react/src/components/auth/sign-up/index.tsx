import { useEffect } from "react";
import { Button } from "@orbitid/ui";
import { AuthAppearanceScope } from "../_shared/appearance";
import { AuthCard } from "../_shared/auth-card";
import { useAuthRuntime, type TranslateFn } from "../_shared/w6";
import { pickSignUp } from "../_shared/api";
import type { SignUpProps } from "../_shared/types";
import { useStep } from "../_shared/use-step";
import { SignUpStartStep, VerifyCodeStep, VerifyEmailLinkStep, ContinueStep, SignUpSuccessStep } from "./steps";
import { SIGN_UP_STEPS, signUpSlug, useSignUpFlow, type SignUpStep } from "./flow";
import { Waitlist } from "../waitlist";
import { TwoFactorSetup } from "../setup-two-factor";
import { AuthLoadingScreen } from "../_shared/loading";

function SignUpInner(props: SignUpProps) {
  const runtime = useAuthRuntime();
  const { t, environment, navigate } = runtime;
  const { step, setStep } = useStep<SignUpStep>({
    routing: props.routing ?? "path",
    path: props.path ?? "/sign-up",
    steps: SIGN_UP_STEPS,
    initialStep: initialSignUpStep(pickSignUp(runtime.orbit, null)),
    slugFor: signUpSlug,
  });
  const flow = useSignUpFlow(props, step, setStep);
  const pendingSession = runtime.session?.status === "pending";

  // Required MFA leaves the new session pending; it may only enrol a factor until then.
  useEffect(() => {
    if (runtime.loaded && pendingSession && !flow.setupCompleted && step !== "setup-mfa") {
      setStep("setup-mfa");
    }
  }, [runtime.loaded, pendingSession, flow.setupCompleted, step, setStep]);

  if (!runtime.loaded) return <AuthLoadingScreen />;

  if (environment.signUp.mode === "waitlist") {
    return <Waitlist afterJoinWaitlistUrl={props.fallbackRedirectUrl} signInUrl={props.signInUrl} />;
  }

  if (environment.signUp.mode === "restricted") {
    return (
      <div className="flex w-full items-center justify-center px-4 py-6">
        <AuthCard title={t("signUp.restricted.title")} subtitle={environment.app.name}>
          <p className="text-center text-sm text-muted-foreground">
            {t("signUp.restricted.message", { applicationName: environment.app.name })}
          </p>
          <Button type="button" variant="link" className="mx-auto h-auto min-h-6 px-0 py-1" onClick={() => navigate(props.signInUrl ?? "/sign-in")}>
            {t("signUp.start.signInAction")}
          </Button>
        </AuthCard>
      </div>
    );
  }

  const copy = signUpCopy(step, t, environment.app.name);

  return (
    <div className="flex w-full items-center justify-center px-4 py-6">
      <AuthCard title={copy.title} subtitle={copy.subtitle}>
        {step === "start" ? <SignUpStartStep flow={flow} props={props} /> : null}
        {step === "verify-email-code" ? <VerifyCodeStep flow={flow} props={props} strategy="email_code" /> : null}
        {step === "verify-email-link" ? <VerifyEmailLinkStep flow={flow} props={props} /> : null}
        {step === "verify-phone-code" ? <VerifyCodeStep flow={flow} props={props} strategy="phone_code" /> : null}
        {step === "continue" ? <ContinueStep flow={flow} props={props} /> : null}
        {step === "setup-mfa" ? (
          <TwoFactorSetup
            sessionId={flow.pendingSessionId ?? runtime.session?.id ?? null}
            onComplete={flow.completeSetup}
          />
        ) : null}
        {step === "success" ? <SignUpSuccessStep /> : null}
      </AuthCard>
    </div>
  );
}

function initialSignUpStep(signUp: ReturnType<typeof pickSignUp>): SignUpStep {
  if (!signUp) return "start";
  if (signUp.status === "complete") return "success";
  if ((signUp.missing_fields ?? []).length > 0) return "continue";
  const unverified = signUp.unverified_fields ?? [];
  if (unverified.includes("email_address")) {
    return signUp.verifications?.email_address?.strategy === "email_link" ? "verify-email-link" : "verify-email-code";
  }
  if (unverified.includes("phone_number")) return "verify-phone-code";
  return "start";
}

function signUpCopy(
  step: SignUpStep,
  t: TranslateFn,
  applicationName: string,
): { title: string; subtitle?: string } {
  switch (step) {
    case "start":
      return { title: t("signUp.start.title"), subtitle: t("signUp.start.subtitle") };
    case "verify-email-code":
      return { title: t("signUp.verifyEmailCode.title") };
    case "verify-email-link":
      return { title: t("signUp.verifyEmailLink.title") };
    case "verify-phone-code":
      return { title: t("signUp.verifyPhoneCode.title") };
    case "continue":
      return { title: t("signUp.continue.title"), subtitle: t("signUp.continue.subtitle") };
    case "setup-mfa":
      return {
        title: t("signIn.setupTwoFactor.title"),
        subtitle: t("signIn.setupTwoFactor.subtitle"),
      };
    case "success":
      return { title: t("signUp.success.title", { applicationName }) };
  }
}

export function SignUp(props: SignUpProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <SignUpInner {...props} />
    </AuthAppearanceScope>
  );
}
