import { useCallback, useContext, useMemo, useState } from "react";
import {
  apiRequest,
  errorMessage,
  finishAuth,
  pickSignUp,
  reloadOrbit,
  signUpAttemptVerification,
  signUpAuthenticateWithRedirect,
  signUpCreate,
  signUpPrepareVerification,
  signUpUpdate,
  verificationStatus,
} from "../_shared/api";
import { useAuthRuntime } from "../_shared/w6";
import { OrbitIDOptionsContext } from "../../../provider";
import { currentClient } from "../_shared/api";
import type { SignUpProps, SignUpResource } from "../_shared/types";

export const SIGN_UP_STEPS = [
  "start",
  "verify-email-code",
  "verify-email-link",
  "verify-phone-code",
  "continue",
  "success",
] as const;

export type SignUpStep = (typeof SIGN_UP_STEPS)[number];

export function signUpSlug(step: SignUpStep): string {
  if (step === "start") return "";
  return step;
}

export interface SignUpInitialForm {
  emailAddress: string;
  phoneNumber: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
}

export interface SignUpFlow {
  signUp: SignUpResource | null;
  error: string | null;
  setError: (value: string | null) => void;
  busy: boolean;
  step: SignUpStep;
  go: (step: SignUpStep) => void;
  redirectTarget: string | undefined;
  ticket: string | null;
  transfer: boolean;
  captchaToken: string | null;
  setCaptchaToken: (token: string | null) => void;
  initialForm: SignUpInitialForm;
  create: (params: Record<string, unknown>) => Promise<SignUpResource | null>;
  update: (params: Record<string, unknown>) => Promise<SignUpResource | null>;
  prepareVerification: (strategy: "email_code" | "email_link" | "phone_code") => Promise<SignUpResource | null>;
  attemptVerification: (
    strategy: "email_code" | "email_link" | "phone_code",
    code: string,
  ) => Promise<SignUpResource | null>;
  pollCompletion: () => Promise<void>;
  finish: (signUp: SignUpResource) => Promise<void>;
  authenticateWithRedirect: (strategy: string) => Promise<void>;
}

function readTicket(): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get("__orbit_ticket") ?? params.get("__clerk_ticket");
}

function readTransferIdentifier(): { transfer: boolean; identifier: string } {
  if (typeof window === "undefined") return { transfer: false, identifier: "" };
  const params = new URLSearchParams(window.location.search);
  return {
    transfer: params.get("transfer") === "1" || params.get("transfer") === "true",
    identifier: params.get("identifier") ?? "",
  };
}

function signUpWireParams(params: Record<string, unknown>, captchaToken: string): Record<string, unknown> {
  return {
    email_address: params.emailAddress,
    phone_number: params.phoneNumber,
    username: params.username,
    password: params.password,
    first_name: params.firstName,
    last_name: params.lastName,
    strategy: params.strategy,
    ticket: params.ticket,
    transfer: params.transfer,
    legal_accepted: params.legalAccepted,
    unsafe_metadata: params.unsafeMetadata,
    captcha_token: captchaToken,
  };
}

export function preferredEmailStrategy(
  verifications: string[] | undefined,
  signUp: SignUpResource | null,
): "email_code" | "email_link" {
  const fromVerification = signUp?.verifications?.email_address?.strategy;
  if (fromVerification === "email_link" || fromVerification === "email_code") return fromVerification;
  if (verifications?.includes("email_link") && !verifications.includes("email_code")) return "email_link";
  return "email_code";
}

export function useSignUpFlow(props: SignUpProps, step: SignUpStep, go: (step: SignUpStep) => void): SignUpFlow {
  const runtime = useAuthRuntime();
  const options = useContext(OrbitIDOptionsContext);
  const { orbit, t, environment } = runtime;
  const transferInfo = useMemo(readTransferIdentifier, []);
  const ticket = useMemo(readTicket, []);
  const [signUp, setSignUp] = useState<SignUpResource | null>(() => pickSignUp(orbit, null));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);

  const redirectTarget =
    props.forceRedirectUrl ??
    options.signUpForceRedirectUrl ??
    props.fallbackRedirectUrl ??
    options.signUpFallbackRedirectUrl;

  const initialForm = useMemo<SignUpInitialForm>(
    () => ({
      emailAddress: props.initialValues?.emailAddress ?? transferInfo.identifier,
      phoneNumber: props.initialValues?.phoneNumber ?? "",
      username: props.initialValues?.username ?? "",
      firstName: props.initialValues?.firstName ?? "",
      lastName: props.initialValues?.lastName ?? "",
      password: props.initialValues?.password ?? "",
    }),
    [props.initialValues, transferInfo.identifier],
  );

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

  const finish = useCallback(
    async (next: SignUpResource) => {
      if (!next.created_session_id) {
        setError(t("common.internalError"));
        return;
      }
      setBusy(true);
      try {
        await finishAuth(runtime, next.created_session_id, redirectTarget);
        setSignUp(next);
        if (!redirectTarget) go("success");
      } catch (caught) {
        setError(errorMessage(t, caught));
      } finally {
        setBusy(false);
      }
    },
    [runtime, redirectTarget, t, go],
  );

  const prepareVerification = useCallback(
    async (strategy: "email_code" | "email_link" | "phone_code") => {
      const next = await run(() => signUpPrepareVerification(orbit, strategy));
      if (next) {
        setSignUp(next);
        go(
          strategy === "email_code"
            ? "verify-email-code"
            : strategy === "email_link"
              ? "verify-email-link"
              : "verify-phone-code",
        );
      }
      return next;
    },
    [orbit, run, go],
  );

  const route = useCallback(
    async (next: SignUpResource, options: { prepare?: boolean } = {}) => {
      setSignUp(next);
      if (next.status === "complete") {
        await finish(next);
        return;
      }
      const unverified = next.unverified_fields ?? [];
      const missing = next.missing_fields ?? [];
      const emailVerification = next.verifications?.email_address ?? null;
      const phoneVerification = next.verifications?.phone_number ?? null;

      if (
        unverified.includes("email_address") ||
        (environment.attributes.email_address.enabled &&
          verificationStatus(emailVerification) === "unverified" &&
          next.email_address)
      ) {
        if (options.prepare !== false) {
          const strategy = preferredEmailStrategy(environment.attributes.email_address.verifications, next);
          await prepareVerification(strategy);
        } else {
          go(
            preferredEmailStrategy(environment.attributes.email_address.verifications, next) === "email_link"
              ? "verify-email-link"
              : "verify-email-code",
          );
        }
        return;
      }
      if (
        unverified.includes("phone_number") ||
        (environment.attributes.phone_number.enabled &&
          verificationStatus(phoneVerification) === "unverified" &&
          next.phone_number)
      ) {
        if (options.prepare !== false) await prepareVerification("phone_code");
        else go("verify-phone-code");
        return;
      }
      if (missing.length > 0) {
        go("continue");
        return;
      }
      go("continue");
    },
    [environment, finish, prepareVerification, go],
  );

  const create = useCallback(
    async (params: Record<string, unknown>) => {
      const merged = {
        ...params,
        ...(ticket ? { ticket } : {}),
        ...(transferInfo.transfer ? { transfer: true } : {}),
        ...(props.unsafeMetadata ? { unsafeMetadata: props.unsafeMetadata } : {}),
      };
      // `@orbitid/js` does not forward captcha tokens yet: submit the wire request directly so the
      // server can verify `captcha_token`, then reload the client it returns via cookie.
      const next = await run(async () => {
        if (captchaToken) {
          await apiRequest(orbit, "/v1/client/sign_ups", {
            method: "POST",
            json: signUpWireParams(merged, captchaToken),
          });
          await reloadOrbit(orbit);
          return pickSignUp(orbit, null);
        }
        return signUpCreate(orbit, { ...merged, ...(captchaToken ? { captchaToken } : {}) });
      });
      if (next) await route(next);
      return next;
    },
    [orbit, run, route, captchaToken, ticket, transferInfo.transfer, props.unsafeMetadata],
  );

  const update = useCallback(
    async (params: Record<string, unknown>) => {
      const next = await run(() => signUpUpdate(orbit, params));
      if (next) await route(next);
      return next;
    },
    [orbit, run, route],
  );

  const attemptVerification = useCallback(
    async (strategy: "email_code" | "email_link" | "phone_code", code: string) => {
      const next = await run(() => signUpAttemptVerification(orbit, strategy, code));
      if (next) await route(next, { prepare: false });
      return next;
    },
    [orbit, run, route],
  );

  const authenticateWithRedirect = useCallback(
    async (strategy: string) => {
      const redirectUrl = typeof window === "undefined" ? undefined : window.location.href;
      const next = await run(() =>
        signUpAuthenticateWithRedirect(orbit, {
          strategy,
          redirectUrl,
          redirectUrlComplete: redirectTarget,
          ...(ticket ? { ticket } : {}),
        }),
      );
      if (next) await route(next);
    },
    [orbit, run, redirectTarget, route, ticket],
  );

  const pollCompletion = useCallback(async () => {
    await reloadOrbit(orbit);
    const activeSession = currentClient(orbit)?.last_active_session_id;
    const next = pickSignUp(orbit, null);
    if (next) {
      setSignUp(next);
      if (next.status === "complete" && next.created_session_id) {
        await finish(next);
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
  }, [orbit, runtime, redirectTarget, finish, go, t]);

  return {
    signUp,
    error,
    setError,
    busy,
    step,
    go,
    redirectTarget,
    ticket,
    transfer: transferInfo.transfer,
    captchaToken,
    setCaptchaToken,
    initialForm,
    create,
    update,
    prepareVerification,
    attemptVerification,
    pollCompletion,
    finish,
    authenticateWithRedirect,
  };
}
