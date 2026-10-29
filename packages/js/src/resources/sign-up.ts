import type { Metadata, SignUpJSON, SignUpStatus } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData } from "./base";
import { Verification } from "./verification";

export interface SignUpCreateParams {
  emailAddress?: string;
  phoneNumber?: string;
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  /** OAuth / SSO / enterprise strategy, e.g. `oauth_google`, or `anonymous` for a guest account. */
  strategy?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
  ticket?: string;
  unsafeMetadata?: Metadata;
  publicMetadata?: Metadata;
  legalAccepted?: boolean;
  /** Adopt a transferable sign-in (OAuth completed, but the account needs more fields). */
  transfer?: boolean;
}

export interface SignUpVerificationParams {
  strategy?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
}

export interface AttemptVerificationParams {
  strategy: string;
  code: string;
}

export interface AuthenticateWithRedirectParams {
  strategy: string;
  redirectUrl: string;
  redirectUrlComplete: string;
  emailAddress?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
}

export class SignUp {
  readonly object = "sign_up" as const;
  id: string;
  status: SignUpStatus;
  requiredFields: string[];
  optionalFields: string[];
  missingFields: string[];
  unverifiedFields: string[];
  emailAddressVerification: Verification | null;
  phoneNumberVerification: Verification | null;
  externalAccountVerification: Verification | null;
  web3WalletVerification: Verification | null;
  username: string | null;
  emailAddress: string | null;
  phoneNumber: string | null;
  firstName: string | null;
  lastName: string | null;
  passwordEnabled: boolean;
  unsafeMetadata: Metadata;
  publicMetadata: Metadata;
  customAction: boolean;
  externalId: string | null;
  createdSessionId: string | null;
  createdUserId: string | null;
  abandonAt: number;
  legalAcceptedAt: number | null;

  constructor(
    private readonly fapi: FapiClient,
    json: SignUpJSON | null,
  ) {
    this.id = json?.id ?? "";
    this.status = json?.status ?? "missing_requirements";
    this.requiredFields = json?.required_fields ?? [];
    this.optionalFields = json?.optional_fields ?? [];
    this.missingFields = json?.missing_fields ?? [];
    this.unverifiedFields = json?.unverified_fields ?? [];
    this.emailAddressVerification = Verification.fromJSON(json?.verifications?.email_address);
    this.phoneNumberVerification = Verification.fromJSON(json?.verifications?.phone_number);
    this.externalAccountVerification = Verification.fromJSON(json?.verifications?.external_account);
    this.web3WalletVerification = Verification.fromJSON(json?.verifications?.web3_wallet);
    this.username = json?.username ?? null;
    this.emailAddress = json?.email_address ?? null;
    this.phoneNumber = json?.phone_number ?? null;
    this.firstName = json?.first_name ?? null;
    this.lastName = json?.last_name ?? null;
    this.passwordEnabled = json?.password_enabled ?? false;
    this.unsafeMetadata = json?.unsafe_metadata ?? {};
    this.publicMetadata = json?.public_metadata ?? {};
    this.customAction = json?.custom_action ?? false;
    this.externalId = json?.external_id ?? null;
    this.createdSessionId = json?.created_session_id ?? null;
    this.createdUserId = json?.created_user_id ?? null;
    this.abandonAt = json?.abandon_at ?? 0;
    this.legalAcceptedAt = json?.legal_accepted_at ?? null;
  }

  static fromJSON(fapi: FapiClient, json: SignUpJSON | null): SignUp {
    return new SignUp(fapi, json);
  }

  /** All verification resources keyed by identifier (`verifications.emailAddress`, …). */
  get verifications(): Record<"emailAddress" | "phoneNumber" | "externalAccount" | "web3Wallet", Verification | null> {
    return {
      emailAddress: this.emailAddressVerification,
      phoneNumber: this.phoneNumberVerification,
      externalAccount: this.externalAccountVerification,
      web3Wallet: this.web3WalletVerification,
    };
  }

  get isComplete(): boolean {
    return this.status === "complete";
  }

  private get basePath(): string {
    if (!this.id) throw new Error("SignUp has not been created yet");
    return `/v1/client/sign_ups/${this.id}`;
  }

  private applyJSON(json: SignUpJSON): this {
    this.id = json.id;
    this.status = json.status;
    this.requiredFields = json.required_fields ?? this.requiredFields;
    this.optionalFields = json.optional_fields ?? this.optionalFields;
    this.missingFields = json.missing_fields ?? [];
    this.unverifiedFields = json.unverified_fields ?? [];
    this.emailAddressVerification = Verification.fromJSON(json.verifications?.email_address) ?? this.emailAddressVerification;
    this.phoneNumberVerification = Verification.fromJSON(json.verifications?.phone_number) ?? this.phoneNumberVerification;
    this.externalAccountVerification = Verification.fromJSON(json.verifications?.external_account) ?? this.externalAccountVerification;
    this.web3WalletVerification = Verification.fromJSON(json.verifications?.web3_wallet) ?? this.web3WalletVerification;
    this.username = json.username ?? this.username;
    this.emailAddress = json.email_address ?? this.emailAddress;
    this.phoneNumber = json.phone_number ?? this.phoneNumber;
    this.firstName = json.first_name ?? this.firstName;
    this.lastName = json.last_name ?? this.lastName;
    this.passwordEnabled = json.password_enabled ?? this.passwordEnabled;
    this.unsafeMetadata = json.unsafe_metadata ?? this.unsafeMetadata;
    this.publicMetadata = json.public_metadata ?? this.publicMetadata;
    this.customAction = json.custom_action ?? this.customAction;
    this.externalId = json.external_id ?? this.externalId;
    this.createdSessionId = json.created_session_id ?? this.createdSessionId;
    this.createdUserId = json.created_user_id ?? this.createdUserId;
    this.abandonAt = json.abandon_at ?? this.abandonAt;
    this.legalAcceptedAt = json.legal_accepted_at ?? this.legalAcceptedAt;
    return this;
  }

  async create(params: SignUpCreateParams = {}): Promise<this> {
    const json = await fetchData<SignUpJSON>(this.fapi, "POST", "/v1/client/sign_ups", {
      body: {
        email_address: params.emailAddress,
        phone_number: params.phoneNumber,
        username: params.username,
        password: params.password,
        first_name: params.firstName,
        last_name: params.lastName,
        strategy: params.strategy,
        redirect_url: params.redirectUrl,
        action_complete_redirect_url: params.actionCompleteRedirectUrl,
        ticket: params.ticket,
        unsafe_metadata: params.unsafeMetadata,
        public_metadata: params.publicMetadata,
        legal_accepted: params.legalAccepted,
        transfer: params.transfer,
      },
    });
    return this.applyJSON(json);
  }

  /**
   * Creates a guest account: a user with no identifiers (and no password) plus an active session.
   * The account upgrades in place as soon as it gains a verified identifier or a password.
   * Requires `anonymous.enabled` on the instance; otherwise the server answers `sign_up_restricted`.
   */
  async createAnonymous(params: { unsafeMetadata?: Metadata; legalAccepted?: boolean } = {}): Promise<this> {
    return this.create({ strategy: "anonymous", unsafeMetadata: params.unsafeMetadata, legalAccepted: params.legalAccepted });
  }

  /** PATCHes the in-progress sign-up (add/update identifier or profile fields). */
  async update(params: SignUpCreateParams): Promise<this> {
    const json = await fetchData<SignUpJSON>(this.fapi, "PATCH", this.basePath, {
      body: {
        email_address: params.emailAddress,
        phone_number: params.phoneNumber,
        username: params.username,
        password: params.password,
        first_name: params.firstName,
        last_name: params.lastName,
        unsafe_metadata: params.unsafeMetadata,
        public_metadata: params.publicMetadata,
        legal_accepted: params.legalAccepted,
      },
    });
    return this.applyJSON(json);
  }

  async reload(): Promise<this> {
    return this.applyJSON(await fetchData<SignUpJSON>(this.fapi, "GET", this.basePath));
  }

  async prepareVerification(params: SignUpVerificationParams = {}): Promise<this> {
    const json = await fetchData<SignUpJSON>(this.fapi, "POST", `${this.basePath}/prepare_verification`, {
      body: {
        strategy: params.strategy ?? "email_code",
        redirect_url: params.redirectUrl,
        action_complete_redirect_url: params.actionCompleteRedirectUrl,
      },
    });
    return this.applyJSON(json);
  }

  async attemptVerification(params: AttemptVerificationParams): Promise<this> {
    const json = await fetchData<SignUpJSON>(this.fapi, "POST", `${this.basePath}/attempt_verification`, {
      body: { strategy: params.strategy, code: params.code },
    });
    return this.applyJSON(json);
  }

  async prepareEmailAddressVerification(params: SignUpVerificationParams = {}): Promise<this> {
    return this.prepareVerification({ ...params, strategy: params.strategy ?? "email_code" });
  }

  async attemptEmailAddressVerification(params: { code: string }): Promise<this> {
    return this.attemptVerification({ strategy: "email_code", code: params.code });
  }

  async preparePhoneNumberVerification(params: SignUpVerificationParams = {}): Promise<this> {
    return this.prepareVerification({ ...params, strategy: params.strategy ?? "phone_code" });
  }

  async attemptPhoneNumberVerification(params: { code: string }): Promise<this> {
    return this.attemptVerification({ strategy: "phone_code", code: params.code });
  }

  /** OAuth / enterprise sign-up; navigates to the provider. */
  async authenticateWithRedirect(params: AuthenticateWithRedirectParams): Promise<this> {
    await this.create({
      strategy: params.strategy,
      emailAddress: params.emailAddress,
      firstName: params.firstName,
      lastName: params.lastName,
      username: params.username,
      redirectUrl: params.redirectUrl,
      actionCompleteRedirectUrl: params.redirectUrlComplete,
    });
    const target = this.externalAccountVerification?.externalVerificationRedirectUrl;
    if (!target) throw new Error("OrbitID did not return an external verification redirect URL");
    this.fapi.redirectTo(target);
    return this;
  }

  /** Magic-link sign-up: send the link, then poll until the attempt completes. */
  createEmailLinkFlow(options: { pollingIntervalMs?: number; maxPollingMs?: number } = {}): {
    startEmailLinkFlow: (params?: { redirectUrl?: string; pollingIntervalMs?: number }) => Promise<{ cancel: () => void }>;
  } {
    return {
      startEmailLinkFlow: async (params = {}) => {
        await this.prepareEmailAddressVerification({ strategy: "email_link", redirectUrl: params.redirectUrl });
        let cancelled = false;
        let elapsed = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const interval = params.pollingIntervalMs ?? options.pollingIntervalMs ?? 500;
        const maxPolling = options.maxPollingMs ?? 10 * 60 * 1000;
        const poll = async () => {
          if (cancelled) return;
          try {
            await this.reload();
          } catch {
            /* transient network errors: keep polling */
          }
          if (cancelled || this.status !== "missing_requirements") return;
          elapsed += interval;
          if (elapsed >= maxPolling) return;
          timer = setTimeout(poll, interval);
        };
        timer = setTimeout(poll, interval);
        return {
          cancel: () => {
            cancelled = true;
            clearTimeout(timer);
          },
        };
      },
    };
  }

  /** Verification status for a given wire field, mirroring the server's `unverified_fields`. */
  getVerificationFor(field: "email_address" | "phone_number" | "external_account" | "web3_wallet"): Verification | null {
    switch (field) {
      case "email_address":
        return this.emailAddressVerification;
      case "phone_number":
        return this.phoneNumberVerification;
      case "external_account":
        return this.externalAccountVerification;
      case "web3_wallet":
        return this.web3WalletVerification;
    }
  }
}
