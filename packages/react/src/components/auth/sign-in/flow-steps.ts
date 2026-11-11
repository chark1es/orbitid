import { factorsOf, isTransferable } from "../_shared/api";
import type { SignInFactorView } from "../_shared/w6";
import type { SignInProps, SignInResource } from "../_shared/types";

export const SIGN_IN_STEPS = [
  "start",
  "password",
  "email-code",
  "email-link",
  "phone-code",
  "forgot-password",
  "reset-password-code",
  "reset-password",
  "choose-strategy",
  "second-factor",
  "enterprise-sso",
  "transfer",
  "sso-callback",
  "setup-mfa",
  "success",
] as const;

export type SignInStep = (typeof SIGN_IN_STEPS)[number];

export function signInSlug(step: SignInStep): string {
  if (step === "start") return "";
  if (step === "password") return "factor-one";
  if (step === "second-factor") return "factor-two";
  return step;
}

export function signInStepFromStatus(signIn: SignInResource | null): SignInStep {
  if (!signIn) return "start";
  if (isTransferable(signIn)) return "transfer";
  if (signIn.status === "needs_second_factor") return "second-factor";
  if (signIn.status === "needs_new_password") return "reset-password";
  if (signIn.status === "needs_first_factor") {
    const prepared = signIn.first_factor_verification?.strategy;
    if (prepared === "email_code") return "email-code";
    if (prepared === "email_link") return "email-link";
    if (prepared === "phone_code") return "phone-code";
    if (prepared === "reset_password_email_code") return "reset-password-code";
    const factors = factorsOf(signIn, "first");
    if (factors.some((factor) => factor.strategy === "password")) return "password";
  }
  return "start";
}

export interface SignInFlow {
  signIn: SignInResource | null;
  identifier: string;
  identifierDraft: string;
  setIdentifierDraft: (value: string) => void;
  error: string | null;
  setError: (value: string | null) => void;
  /** One-time explanation for a step the flow routed to automatically, e.g. after a password reset. */
  notice: string | null;
  busy: boolean;
  step: SignInStep;
  go: (step: SignInStep) => void;
  redirectTarget: string | undefined;
  create: (params: Record<string, unknown>, options?: { route?: boolean }) => Promise<SignInResource | null>;
  prepareFirstFactor: (strategy: string, extra?: Record<string, unknown>) => Promise<SignInResource | null>;
  attemptFirstFactor: (params: Record<string, unknown>) => Promise<SignInResource | null>;
  prepareSecondFactor: (strategy: string, extra?: Record<string, unknown>) => Promise<SignInResource | null>;
  attemptSecondFactor: (params: Record<string, unknown>) => Promise<SignInResource | null>;
  resetPassword: (params: Record<string, unknown>) => Promise<SignInResource | null>;
  authenticateWithRedirect: (strategy: string, extra?: Record<string, unknown>) => Promise<void>;
  authenticateWithPasskey: (options?: { autofill?: boolean }) => Promise<void>;
  selectFirstFactor: (factor: SignInFactorView) => Promise<void>;
  enterSecondFactor: (signIn: SignInResource) => Promise<void>;
  complete: (signIn: SignInResource) => Promise<void>;
  /** The session the sign-in created, while the server keeps it `pending` for MFA enrolment. */
  pendingSessionId: string | null;
  /** Continue after enrolment: the server activated the session, so navigate to the redirect. */
  completeSetup: () => void;
  /** True once enrolment finished, so the pending-session guard stops pulling the UI back. */
  setupCompleted: boolean;
  pollCompletion: () => Promise<void>;
}


export function isEmailIdentifier(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function signUpUrlFor(
  props: SignInProps,
  transfer?: { identifier?: string | null },
  fallbackBase?: string,
): string {
  const base = props.signUpUrl ?? fallbackBase ?? "/sign-up";
  const params = new URLSearchParams();
  if (transfer?.identifier) params.set("transfer", "1");
  if (transfer?.identifier) params.set("identifier", transfer.identifier);
  const query = params.toString();
  return query ? `${base}${base.includes("?") ? "&" : "?"}${query}` : base;
}
