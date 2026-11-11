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
import type { OrbitInstance, SignInFactorView } from "../_shared/w6";
import { useAuthRuntime } from "../_shared/w6";
import { OrbitIDOptionsContext } from "../../../provider";
import type { SignInProps, SignInResource } from "../_shared/types";
import { currentClient } from "../_shared/api";
import { safeRedirectUrlFromLocation } from "../../../lib/redirects";
import { type SignInStep, type SignInFlow } from "./flow-steps";

/** True when the server created the session as `pending` (required MFA, no factor enrolled yet). */
function isPendingSession(orbit: OrbitInstance, sessionId: string | null): boolean {
  if (!sessionId) return false;
  const sessions = currentClient(orbit)?.sessions ?? [];
  return sessions.some((session) => session.id === sessionId && session.status === "pending");
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
  /** One-time explanation for the step that follows an automatic route (for example after a reset). */
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(() =>
    runtime.session?.status === "pending" ? runtime.session.id : null,
  );
  const [setupCompleted, setSetupCompleted] = useState(false);

  const redirectTarget = useMemo(
    () =>
      props.forceRedirectUrl ??
      options.signInForceRedirectUrl ??
      safeRedirectUrlFromLocation({ allowedRedirectOrigins: options.allowedRedirectOrigins }) ??
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
      const sessionId = next.created_session_id;
      setBusy(true);
      try {
        if (isPendingSession(orbit, sessionId)) {
          setSignIn(next);
          setPendingSessionId(sessionId);
          go("setup-mfa");
          return;
        }
        await finishAuth(runtime, sessionId, redirectTarget);
        setSignIn(next);
        if (!redirectTarget) go("success");
      } catch (caught) {
        // The server rejects activation for a pending session; show the enrolment step instead.
        if (toAuthError(caught).code === "session_pending") {
          setSignIn(next);
          setPendingSessionId(sessionId);
          go("setup-mfa");
          return;
        }
        setError(errorMessage(t, caught));
      } finally {
        setBusy(false);
      }
    },
    [orbit, runtime, redirectTarget, t, go],
  );

  const enterSecondFactor = useCallback(
    async (next: SignInResource) => {
      setSignIn(next);
      const factors = factorsOf(next, "second");
      const preferred =
        factors.find((factor) => factor.default) ??
        factors.find((factor) => factor.strategy === "totp") ??
        factors[0];
      if (preferred?.strategy === "phone_code" || preferred?.strategy === "email_code") {
        await run(() =>
          signInPrepareSecondFactor(orbit, {
            strategy: preferred.strategy,
            ...(preferred.phone_number_id ? { phoneNumberId: preferred.phone_number_id } : {}),
            ...(preferred.email_address_id ? { emailAddressId: preferred.email_address_id } : {}),
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
      setNotice(null);
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
        else if (next.status === "needs_first_factor") {
          // The server deliberately refuses to create a session when recovery consumed the channel of the
          // account's only second factor: the password is now changed, so ask for it again before MFA.
          setNotice(t("signIn.resetPassword.changed"));
          go("password");
        }
      }
      return next;
    },
    [orbit, run, complete, enterSecondFactor, go, t],
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
    if (options?.autofill) {
      // Conditional UI runs in the background: a dismissed or unavailable prompt is not an error to show.
      try {
        const result = await signInAuthenticateWithPasskey(orbit, options);
        if (result?.signIn) await route(result.signIn);
      } catch {
        /* the user kept typing an identifier instead */
      }
      return;
    }
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
      if (isPendingSession(orbit, activeSession)) {
        setPendingSessionId(activeSession);
        go("setup-mfa");
        return;
      }
      try {
        await finishAuth(runtime, activeSession, redirectTarget);
        if (!redirectTarget) go("success");
      } catch (caught) {
        if (toAuthError(caught).code === "session_pending") {
          setPendingSessionId(activeSession);
          go("setup-mfa");
          return;
        }
        setError(errorMessage(t, caught));
      }
    }
  }, [orbit, runtime, redirectTarget, complete, go, t]);

  const completeSetup = useCallback(() => {
    setPendingSessionId(null);
    setSetupCompleted(true);
    if (redirectTarget) runtime.navigate(redirectTarget, { replace: true });
    else go("success");
  }, [runtime, redirectTarget, go]);

  // A magic link opened in a different browser than the one that asked for it is refused; say so instead of showing nothing.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("__orbit_status") === "different_browser") {
      setError(t("unstable__errors.link_different_browser"));
    }
  }, [t]);

  // Sign-in tokens and impersonation links from the Backend API arrive as `?__orbit_ticket=`.
  // A visitor who already has an active session skips the form and goes where the sign-in would have led.
  const ticketStarted = useRef(false);
  useEffect(() => {
    if (!runtime.loaded || ticketStarted.current || typeof window === "undefined") return;
    const ticket = new URLSearchParams(window.location.search).get("__orbit_ticket");
    if (!ticket) {
      const leavesThisPage = (target: string) => {
        try {
          return new URL(target, window.location.href).pathname !== window.location.pathname;
        } catch {
          return false;
        }
      };
      if (runtime.session?.status === "active" && redirectTarget && leavesThisPage(redirectTarget)) {
        ticketStarted.current = true;
        runtime.navigate(redirectTarget, { replace: true });
      }
      return;
    }
    ticketStarted.current = true;
    void create({ strategy: "ticket", ticket });
  }, [runtime, redirectTarget, create]);

  return {
    signIn,
    identifier: signIn?.identifier ?? identifierDraft,
    identifierDraft,
    setIdentifierDraft,
    error,
    setError,
    notice,
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
    pendingSessionId,
    completeSetup,
    setupCompleted,
    pollCompletion,
  };
}
