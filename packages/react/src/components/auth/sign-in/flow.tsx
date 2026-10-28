import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  errorMessage,
  finishAuth,
  factorsOf,
  isTransferable,
  pickSignIn,
  reloadOrbit,
  signInAttemptFirstFactor,
  signInAttemptSecondFactor,
  signInAuthenticateWithPasskey,
  signInAuthenticateWithRedirect,
  signInCreate,
  signInPrepareFirstFactor,
  signInPrepareSecondFactor,
  signInResetPassword,
  toAuthError,
} from "../_shared/api";
import type { SignInFactorView } from "../_shared/w6";
import { useAuthRuntime } from "../_shared/w6";
import { OrbitIDOptionsContext } from "../../../provider";
import type { SignInProps, SignInResource } from "../_shared/types";
import { currentClient } from "../_shared/api";

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
  pollCompletion: () => Promise<void>;
}

export function useSignInFlow(props: SignInProps, step: SignInStep, go: (step: SignInStep) => void): SignInFlow {
  const runtime = useAuthRuntime();
  const options = useContext(OrbitIDOptionsContext);
  const { orbit, t } = runtime;
  const [signIn, setSignIn] = useState<SignInResource | null>(() => pickSignIn(orbit, null));
  const [identifierDraft, setIdentifierDraft] = useState(
    props.initialValues?.identifier ??
      props.initialValues?.emailAddress ??
      props.initialValues?.phoneNumber ??
      props.initialValues?.username ??
      "",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const redirectTarget = useMemo(
    () =>
      props.forceRedirectUrl ??
      options.signInForceRedirectUrl ??
      props.fallbackRedirectUrl ??
      options.signInFallbackRedirectUrl ??
      undefined,
    [props.forceRedirectUrl, props.fallbackRedirectUrl, options.signInForceRedirectUrl, options.signInFallbackRedirectUrl],
  );

  const signInRef = useRef(signIn);
  signInRef.current = signIn;

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        return await action();
      } catch (caught) {
        setError(errorMessage(t, caught));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const complete = useCallback(
    async (next: SignInResource) => {
      if (!next.created_session_id) {
        setError(t("common.internalError"));
        return;
      }
      setBusy(true);
      try {
        await finishAuth(runtime, next.created_session_id, redirectTarget);
        setSignIn(next);
        if (!redirectTarget) go("success");
      } catch (caught) {
        setError(errorMessage(t, caught));
      } finally {
        setBusy(false);
      }
    },
    [runtime, redirectTarget, t, go],
  );

  const enterSecondFactor = useCallback(
    async (next: SignInResource) => {
      setSignIn(next);
      const factors = factorsOf(next, "second");
      const preferred =
        factors.find((factor) => factor.default) ??
        factors.find((factor) => factor.strategy === "totp") ??
        factors[0];
      if (preferred?.strategy === "phone_code") {
        await run(() =>
          signInPrepareSecondFactor(orbit, {
            strategy: "phone_code",
            ...(preferred.phone_number_id ? { phoneNumberId: preferred.phone_number_id } : {}),
          }),
        );
      }
      go("second-factor");
    },
    [orbit, run, go],
  );

  const route = useCallback(
    async (next: SignInResource | null, options: { autoPrepare?: boolean } = {}) => {
      if (!next) return;
      setSignIn(next);
      if (isTransferable(next)) {
        go("transfer");
        return;
      }
      if (next.status === "complete") {
        await complete(next);
        return;
      }
      if (next.status === "needs_second_factor") {
        await enterSecondFactor(next);
        return;
      }
      if (next.status === "needs_new_password") {
        go("reset-password");
        return;
      }
      if (next.status === "needs_first_factor") {
        const factors = factorsOf(next, "first");
        if (factors.some((factor) => factor.strategy === "password")) {
          go("password");
          return;
        }
        const emailCode = factors.find((factor) => factor.strategy === "email_code");
        const emailLink = factors.find((factor) => factor.strategy === "email_link");
        const phoneCode = factors.find((factor) => factor.strategy === "phone_code");
        if (options.autoPrepare !== false && emailCode) {
          const prepared = await run(() =>
            signInPrepareFirstFactor(orbit, {
              strategy: "email_code",
              ...(emailCode.email_address_id ? { emailAddressId: emailCode.email_address_id } : {}),
            }).then((result) => result.signIn),
          );
          if (prepared) setSignIn(prepared);
          go("email-code");
          return;
        }
        if (options.autoPrepare !== false && emailLink) {
          const prepared = await run(() =>
            signInPrepareFirstFactor(orbit, {
              strategy: "email_link",
              ...(emailLink.email_address_id ? { emailAddressId: emailLink.email_address_id } : {}),
            }).then((result) => result.signIn),
          );
          if (prepared) setSignIn(prepared);
          go("email-link");
          return;
        }
        if (options.autoPrepare !== false && phoneCode) {
          const prepared = await run(() =>
            signInPrepareFirstFactor(orbit, {
              strategy: "phone_code",
              ...(phoneCode.phone_number_id ? { phoneNumberId: phoneCode.phone_number_id } : {}),
            }).then((result) => result.signIn),
          );
          if (prepared) setSignIn(prepared);
          go("phone-code");
          return;
        }
        go("choose-strategy");
        return;
      }
      go("start");
    },
    [complete, enterSecondFactor, go, orbit, run],
  );

  const create = useCallback(
    async (params: Record<string, unknown>, options: { route?: boolean } = {}) => {
      const next = await run(() => signInCreate(orbit, params).then((result) => result.signIn));
      if (next) {
        setSignIn(next);
        setIdentifierDraft(next.identifier ?? identifierDraft);
        if (options.route !== false) await route(next);
      }
      return next;
    },
    [orbit, run, route, identifierDraft],
  );

  const prepareFirstFactor = useCallback(
    async (strategy: string, extra: Record<string, unknown> = {}) => {
      const next = await run(() =>
        signInPrepareFirstFactor(orbit, { strategy, ...extra }).then((result) => result.signIn),
      );
      if (next) setSignIn(next);
      return next;
    },
    [orbit, run],
  );

  const attemptFirstFactor = useCallback(
    async (params: Record<string, unknown>) => {
      const next = await run(() =>
        signInAttemptFirstFactor(orbit, params).then((result) => result.signIn),
      );
      if (next) {
        setSignIn(next);
        if (next.status === "complete") await complete(next);
        else if (next.status === "needs_second_factor") await enterSecondFactor(next);
        else if (next.status === "needs_new_password") go("reset-password");
      }
      return next;
    },
    [orbit, run, complete, enterSecondFactor, go],
  );

  const prepareSecondFactor = useCallback(
    async (strategy: string, extra: Record<string, unknown> = {}) => {
      const next = await run(() => signInPrepareSecondFactor(orbit, { strategy, ...extra }));
      if (next) setSignIn(next);
      return next;
    },
    [orbit, run],
  );

  const attemptSecondFactor = useCallback(
    async (params: Record<string, unknown>) => {
      const next = await run(() => signInAttemptSecondFactor(orbit, params));
      if (next) {
        setSignIn(next);
        if (next.status === "complete") await complete(next);
      }
      return next;
    },
    [orbit, run, complete],
  );

  const resetPassword = useCallback(
    async (params: Record<string, unknown>) => {
      const next = await run(() => signInResetPassword(orbit, params));
      if (next) {
        setSignIn(next);
        if (next.status === "complete") await complete(next);
        else if (next.status === "needs_second_factor") await enterSecondFactor(next);
      }
      return next;
    },
    [orbit, run, complete, enterSecondFactor],
  );

  const authenticateWithRedirect = useCallback(
    async (strategy: string, extra: Record<string, unknown> = {}) => {
      const redirectUrl = typeof window === "undefined" ? undefined : window.location.href;
      const next = await run(() =>
        signInAuthenticateWithRedirect(orbit, {
          strategy,
          redirectUrl,
          redirectUrlComplete: redirectTarget,
          ...extra,
        }).then((result) => result),
      );
      if (next) await route(next);
    },
    [orbit, run, redirectTarget, route],
  );

  const authenticateWithPasskey = useCallback(async (options?: { autofill?: boolean }) => {
    const result = await run(() => signInAuthenticateWithPasskey(orbit, options ?? {}));
    if (result?.signIn) await route(result.signIn);
  }, [orbit, run, route]);

  const selectFirstFactor = useCallback(
    async (factor: SignInFactorView) => {
      const { strategy } = factor;
      if (strategy === "password") {
        go("password");
        return;
      }
      if (strategy === "email_code" || strategy === "email_link" || strategy === "phone_code") {
        const prepared = await prepareFirstFactor(strategy, {
          ...(factor.email_address_id ? { emailAddressId: factor.email_address_id } : {}),
          ...(factor.phone_number_id ? { phoneNumberId: factor.phone_number_id } : {}),
        });
        if (prepared) {
          go(
            strategy === "email_code" ? "email-code" : strategy === "email_link" ? "email-link" : "phone-code",
          );
        }
        return;
      }
      if (strategy === "reset_password_email_code" || strategy === "reset_password_phone_code") {
        go("forgot-password");
        return;
      }
      if (strategy === "passkey") {
        await authenticateWithPasskey();
        return;
      }
      if (strategy === "enterprise_sso" || strategy === "saml") {
        go("enterprise-sso");
        return;
      }
      if (strategy.startsWith("oauth_")) {
        await authenticateWithRedirect(strategy);
      }
    },
    [go, prepareFirstFactor, authenticateWithPasskey, authenticateWithRedirect],
  );

  const pollCompletion = useCallback(async () => {
    await reloadOrbit(orbit);
    const activeSession = currentClient(orbit)?.last_active_session_id;
    const next = pickSignIn(orbit, null);
    if (next) {
      setSignIn(next);
      if (next.status === "complete" && next.created_session_id) {
        await complete(next);
        return;
      }
    }
    if (activeSession) {
      try {
        await finishAuth(runtime, activeSession, redirectTarget);
        if (!redirectTarget) go("success");
      } catch (caught) {
        setError(errorMessage(t, caught));
      }
    }
  }, [orbit, runtime, redirectTarget, complete, go, t]);

  // Sign-in tokens and impersonation links from the Backend API arrive as `?__orbit_ticket=`.
  const ticketStarted = useRef(false);
  useEffect(() => {
    if (!runtime.loaded || ticketStarted.current || typeof window === "undefined") return;
    const ticket = new URLSearchParams(window.location.search).get("__orbit_ticket");
    if (!ticket) return;
    ticketStarted.current = true;
    void create({ strategy: "ticket", ticket });
  }, [runtime.loaded, create]);

  return {
    signIn,
    identifier: signIn?.identifier ?? identifierDraft,
    identifierDraft,
    setIdentifierDraft,
    error,
    setError,
    busy,
    step,
    go,
    redirectTarget,
    create,
    prepareFirstFactor,
    attemptFirstFactor,
    prepareSecondFactor,
    attemptSecondFactor,
    resetPassword,
    authenticateWithRedirect,
    authenticateWithPasskey,
    selectFirstFactor,
    enterSecondFactor,
    complete,
    pollCompletion,
  };
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

export { toAuthError };
