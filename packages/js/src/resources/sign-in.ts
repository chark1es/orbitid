import type { SignInFactor as SignInFactorJSON, SignInJSON, SignInStatus } from "@orbitid/shared";
import { startAuthentication, type PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import type { FapiClient } from "../fapi";
import { fetchData } from "./base";
import { Verification } from "./verification";
import {
  clearPendingSignInStrategy,
  commitPendingSignInStrategy,
  isSignInStrategy,
  recordLastUsedStrategy,
  rememberSignInStrategy,
} from "../util/last-used-strategy";

export interface SignInFactor {
  strategy: string;
  emailAddressId?: string;
  safeIdentifier?: string;
  phoneNumberId?: string;
  primary?: boolean;
  default?: boolean;
}

export interface SignInUserData {
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  hasImage: boolean;
}

function mapFactor(factor: SignInFactorJSON): SignInFactor {
  return {
    strategy: factor.strategy,
    emailAddressId: factor.email_address_id,
    safeIdentifier: factor.safe_identifier,
    phoneNumberId: factor.phone_number_id,
    primary: factor.primary,
    default: factor.default,
  };
}

function mapFactors(factors: SignInFactorJSON[] | null | undefined): SignInFactor[] | null {
  return factors ? factors.map(mapFactor) : null;
}

function mapUserData(data: SignInJSON["user_data"]): SignInUserData | null {
  if (!data) return null;
  return { firstName: data.first_name, lastName: data.last_name, imageUrl: data.image_url, hasImage: data.has_image };
}

export interface SignInCreateParams {
  identifier?: string;
  strategy?: string;
  password?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
  ticket?: string;
  /** Transfer a transferable OAuth/SAML sign-in into a sign-up. */
  transfer?: boolean;
}

export interface PrepareFirstFactorParams {
  strategy: string;
  emailAddressId?: string;
  phoneNumberId?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
}

export interface AttemptFirstFactorParams {
  strategy: string;
  code?: string;
  password?: string;
  signature?: string;
  ticket?: string;
  publicKeyCredential?: unknown;
  redirectUrl?: string;
}

export interface PrepareSecondFactorParams {
  strategy: string;
  phoneNumberId?: string;
  emailAddressId?: string;
}

export interface AttemptSecondFactorParams {
  strategy: string;
  code: string;
  signature?: string;
  /** Remember this browser so it skips the second factor until `environment.authConfig.trustedDevices.days`. */
  trustDevice?: boolean;
}

export interface ResetPasswordParams {
  password: string;
  signOutOfOtherSessions?: boolean;
  redirectUrl?: string;
}

export interface AuthenticateWithRedirectParams {
  strategy: string;
  redirectUrl: string;
  redirectUrlComplete: string;
  identifier?: string;
  emailAddress?: string;
  phoneNumber?: string;
}

export interface EmailLinkFlowOptions {
  pollingIntervalMs?: number;
  maxPollingMs?: number;
}

export interface StartEmailLinkFlowParams {
  emailAddressId?: string;
  redirectUrl?: string;
  pollingIntervalMs?: number;
}

export interface EmailLinkFlow {
  startEmailLinkFlow: (params?: StartEmailLinkFlowParams) => Promise<{ cancel: () => void }>;
}

function parseJsonMaybe<T>(value: T | string | null | undefined): T | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * The Frontend API may return either full WebAuthn request options or only the challenge. For a bare challenge we
 * build a discoverable-credential request scoped to the current hostname (the page's RP ID).
 */
function toRequestOptions(nonce: string | null | undefined): PublicKeyCredentialRequestOptionsJSON | null {
  const parsed = parseJsonMaybe<Record<string, unknown>>(nonce);
  if (parsed && typeof parsed.challenge === "string" && (parsed.rpId !== undefined || parsed.allowCredentials !== undefined)) {
    return parsed as unknown as PublicKeyCredentialRequestOptionsJSON;
  }
  if (typeof nonce === "string" && nonce && typeof location !== "undefined") {
    return {
      challenge: nonce,
      rpId: location.hostname,
      timeout: 60_000,
      userVerification: "preferred",
      allowCredentials: [],
    } as PublicKeyCredentialRequestOptionsJSON;
  }
  return null;
}

export class SignIn {
  readonly object = "sign_in" as const;
  id: string;
  status: SignInStatus;
  supportedIdentifiers: string[];
  supportedFirstFactors: SignInFactor[] | null;
  supportedSecondFactors: SignInFactor[] | null;
  firstFactorVerification: Verification | null;
  secondFactorVerification: Verification | null;
  identifier: string | null;
  userData: SignInUserData | null;
  createdSessionId: string | null;
  abandonAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: SignInJSON | null,
  ) {
    this.id = json?.id ?? "";
    this.status = json?.status ?? "needs_identifier";
    this.supportedIdentifiers = json?.supported_identifiers ?? [];
    this.supportedFirstFactors = mapFactors(json?.supported_first_factors);
    this.supportedSecondFactors = mapFactors(json?.supported_second_factors);
    this.firstFactorVerification = Verification.fromJSON(json?.first_factor_verification);
    this.secondFactorVerification = Verification.fromJSON(json?.second_factor_verification);
    this.identifier = json?.identifier ?? null;
    this.userData = mapUserData(json?.user_data ?? null);
    this.createdSessionId = json?.created_session_id ?? null;
    this.abandonAt = json?.abandon_at ?? 0;
  }

  static fromJSON(fapi: FapiClient, json: SignInJSON | null): SignIn {
    return new SignIn(fapi, json);
  }

  private update(json: SignInJSON): this {
    this.id = json.id;
    this.status = json.status;
    this.supportedIdentifiers = json.supported_identifiers ?? this.supportedIdentifiers;
    this.supportedFirstFactors = mapFactors(json.supported_first_factors) ?? this.supportedFirstFactors;
    this.supportedSecondFactors = mapFactors(json.supported_second_factors) ?? this.supportedSecondFactors;
    this.firstFactorVerification = Verification.fromJSON(json.first_factor_verification) ?? this.firstFactorVerification;
    this.secondFactorVerification = Verification.fromJSON(json.second_factor_verification) ?? this.secondFactorVerification;
    this.identifier = json.identifier ?? this.identifier;
    this.userData = mapUserData(json.user_data ?? null) ?? this.userData;
    this.createdSessionId = json.created_session_id ?? this.createdSessionId;
    this.abandonAt = json.abandon_at ?? this.abandonAt;
    return this;
  }

  private get basePath(): string {
    if (!this.id) throw new Error("SignIn has not been created yet");
    return `/v1/client/sign_ins/${this.id}`;
  }

  private post(path: string, body: Record<string, unknown>): Promise<SignInJSON> {
    return fetchData<SignInJSON>(this.fapi, "POST", path, { body });
  }

  /** Remembers a completed method, or holds it until a second factor / redirect completes. */
  private track(json: SignInJSON, strategy?: string): void {
    if (json.status === "complete" && json.created_session_id) {
      if (strategy && isSignInStrategy(strategy)) {
        recordLastUsedStrategy(strategy);
        clearPendingSignInStrategy();
      } else {
        commitPendingSignInStrategy();
      }
      return;
    }
    if (strategy && isSignInStrategy(strategy) && (json.status === "needs_second_factor" || json.status === "needs_new_password")) {
      rememberSignInStrategy(strategy);
    }
  }

  async create(params: SignInCreateParams = {}): Promise<this> {
    const json = await this.post("/v1/client/sign_ins", {
      identifier: params.identifier,
      strategy: params.strategy,
      password: params.password,
      redirect_url: params.redirectUrl,
      action_complete_redirect_url: params.actionCompleteRedirectUrl,
      ticket: params.ticket,
      transfer: params.transfer,
    });
    this.update(json);
    this.track(json, params.strategy);
    return this;
  }

  /** Re-fetches the sign-in attempt (used by polling flows). */
  async reload(): Promise<this> {
    const json = await fetchData<SignInJSON>(this.fapi, "GET", this.basePath);
    this.update(json);
    if (json.status === "complete") commitPendingSignInStrategy();
    return this;
  }

  async prepareFirstFactor(params: PrepareFirstFactorParams): Promise<this> {
    const json = await this.post(`${this.basePath}/prepare_first_factor`, {
      strategy: params.strategy,
      email_address_id: params.emailAddressId,
      phone_number_id: params.phoneNumberId,
      redirect_url: params.redirectUrl,
      action_complete_redirect_url: params.actionCompleteRedirectUrl,
    });
    this.update(json);
    // A magic link completes while the page is polling, not in this response, so hold the method.
    rememberSignInStrategy(params.strategy);
    if (json.status === "complete") commitPendingSignInStrategy();
    return this;
  }

  async attemptFirstFactor(params: AttemptFirstFactorParams): Promise<this> {
    const json = await this.post(`${this.basePath}/attempt_first_factor`, {
      strategy: params.strategy,
      code: params.code,
      password: params.password,
      signature: params.signature,
      ticket: params.ticket,
      public_key_credential: params.publicKeyCredential,
      redirect_url: params.redirectUrl,
    });
    this.update(json);
    this.track(json, params.strategy);
    return this;
  }

  async prepareSecondFactor(params: PrepareSecondFactorParams): Promise<this> {
    const json = await this.post(`${this.basePath}/prepare_second_factor`, {
      strategy: params.strategy,
      phone_number_id: params.phoneNumberId,
      email_address_id: params.emailAddressId,
    });
    return this.update(json);
  }

  async attemptSecondFactor(params: AttemptSecondFactorParams): Promise<this> {
    const json = await this.post(`${this.basePath}/attempt_second_factor`, {
      strategy: params.strategy,
      code: params.code,
      signature: params.signature,
      trust_device: params.trustDevice,
    });
    this.update(json);
    if (json.status === "complete") commitPendingSignInStrategy();
    return this;
  }

  /** Completes a `needs_new_password` attempt (forced password reset). */
  async resetPassword(params: ResetPasswordParams): Promise<this> {
    const json = await this.post(`${this.basePath}/reset_password`, {
      password: params.password,
      sign_out_of_other_sessions: params.signOutOfOtherSessions,
      redirect_url: params.redirectUrl,
    });
    this.update(json);
    if (json.status === "complete") commitPendingSignInStrategy();
    return this;
  }

  /** Starts OAuth / enterprise SSO and navigates to the provider. */
  async authenticateWithRedirect(params: AuthenticateWithRedirectParams): Promise<this> {
    // The provider navigates away before the attempt can complete; the return leg commits this.
    rememberSignInStrategy(params.strategy);
    await this.create({
      strategy: params.strategy,
      identifier: params.identifier ?? params.emailAddress ?? params.phoneNumber,
      redirectUrl: params.redirectUrl,
      actionCompleteRedirectUrl: params.redirectUrlComplete,
    });
    const target = this.firstFactorVerification?.externalVerificationRedirectUrl;
    if (!target) throw new Error("OrbitID did not return an external verification redirect URL");
    this.fapi.redirectTo(target);
    return this;
  }

  /**
   * WebAuthn sign-in (discoverable credential or conditional UI).
   * `create → prepare_first_factor(passkey) → startAuthentication → attempt_first_factor`.
   */
  async authenticateWithPasskey(options: { autofill?: boolean } = {}): Promise<this> {
    if (!this.id) await this.create({ strategy: "passkey" });
    let optionsJSON = toRequestOptions(this.firstFactorVerification?.nonce);
    if (!optionsJSON) {
      await this.prepareFirstFactor({ strategy: "passkey" });
      optionsJSON = toRequestOptions(this.firstFactorVerification?.nonce);
    }
    if (!optionsJSON) throw new Error("OrbitID did not return passkey request options");
    const credential = await startAuthentication({ optionsJSON, useBrowserAutofill: options.autofill });
    return this.attemptFirstFactor({ strategy: "passkey", publicKeyCredential: credential });
  }

  /** Returns a helper that sends a magic link then polls until the attempt leaves `needs_first_factor`. */
  createEmailLinkFlow(options: EmailLinkFlowOptions = {}): EmailLinkFlow {
    return {
      startEmailLinkFlow: async (params: StartEmailLinkFlowParams = {}) => {
        const emailAddressId =
          params.emailAddressId ?? this.supportedFirstFactors?.find((factor) => factor.strategy === "email_link")?.emailAddressId;
        await this.prepareFirstFactor({
          strategy: "email_link",
          emailAddressId: emailAddressId ?? undefined,
          redirectUrl: params.redirectUrl,
        });
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        // Honour a caller-provided cadence; only an unusable value (0, NaN, negative) falls back to the default.
        const requestedInterval = params.pollingIntervalMs ?? options.pollingIntervalMs ?? 500;
        const interval = Number.isFinite(requestedInterval) && requestedInterval > 0 ? requestedInterval : 500;
        const maxPolling = options.maxPollingMs ?? 10 * 60 * 1000;
        const startedAt = Date.now();
        const poll = async () => {
          if (cancelled) return;
          try {
            await this.reload();
          } catch {
            /* transient network errors: keep polling */
          }
          // `cancel()` may have run while the request was in flight; stop before scheduling another tick.
          if (cancelled || this.status !== "needs_first_factor") return;
          // Wall-clock bound, not an accumulation of interval arithmetic, so a slow request cannot extend the flow.
          if (Date.now() - startedAt >= maxPolling) return;
          timer = setTimeout(poll, interval);
        };
        timer = setTimeout(poll, interval);
        return {
          cancel: () => {
            cancelled = true;
            clearTimeout(timer);
            timer = undefined;
          },
        };
      },
    };
  }
}
