import { vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  createFakeOrbitID,
  fakeEnvironment,
  fakeSession,
  fakeSignIn,
  fakeSignUp,
  fakeUser,
  renderWithProvider,
  type FakeInstance,
} from "../../../__tests__/helpers";
import type { OrbitIDProviderProps } from "../../../provider/types";
import type { EnvironmentResource, SignInResource, SignUpResource, UserResource } from "../../../provider/types";

export const EMAIL_ID = "idn_e1";
export const SESSION_ID = "sess_1";

export function authEnvironment(overrides: Partial<EnvironmentResource> = {}): EnvironmentResource {
  const environment = fakeEnvironment();
  environment.userSettings.attributes = {
    emailAddress: {
      enabled: true,
      required: true,
      usedForFirstFactor: true,
      usedForSecondFactor: false,
      verifications: ["email_code"],
      verifyAtSignUp: true,
    },
    password: {
      enabled: true,
      required: true,
      usedForFirstFactor: true,
      usedForSecondFactor: false,
      verifications: [],
      verifyAtSignUp: false,
    },
    firstName: {
      enabled: true,
      required: false,
      usedForFirstFactor: false,
      usedForSecondFactor: false,
      verifications: [],
      verifyAtSignUp: false,
    },
    lastName: {
      enabled: true,
      required: false,
      usedForFirstFactor: false,
      usedForSecondFactor: false,
      verifications: [],
      verifyAtSignUp: false,
    },
  };
  environment.displayConfig.applicationName = "Acme";
  environment.displayConfig.branded = true;
  environment.displayConfig.theme = "light";
  Object.assign(environment, overrides);
  return environment;
}

export function verifiedEmail(id = EMAIL_ID, emailAddress = "ada@example.com") {
  return {
    id,
    emailAddress,
    verification: { status: "verified", strategy: "email_code", attempts: null, expireAt: null },
    prepareVerification: vi.fn(async function (this: unknown) {
      return this;
    }),
    attemptVerification: vi.fn(async function (this: unknown) {
      return this;
    }),
    destroy: vi.fn(async () => undefined),
  };
}

export function authUser(overrides: Partial<UserResource> = {}): UserResource {
  return fakeUser({
    firstName: "Ada",
    lastName: "Lovelace",
    imageUrl: "",
    hasImage: false,
    primaryEmailAddressId: EMAIL_ID,
    emailAddresses: [verifiedEmail()],
    phoneNumbers: [],
    externalAccounts: [],
    passkeys: [],
    passwordEnabled: true,
    totpEnabled: false,
    backupCodeEnabled: false,
    twoFactorEnabled: false,
    deleteSelfEnabled: true,
    update: vi.fn(async function (this: unknown) {
      return this;
    }),
    delete: vi.fn(async () => undefined),
    updatePassword: vi.fn(async () => undefined),
    removePassword: vi.fn(async () => undefined),
    createTOTP: vi.fn(async () => ({ secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x", qrCode: "data:image/png;base64,AAAA" })),
    verifyTOTP: vi.fn(async () => ({ verified: true })),
    disableTOTP: vi.fn(async () => undefined),
    createBackupCode: vi.fn(async () => ({ codes: ["AAAA1111", "BBBB2222"] })),
    createPasskey: vi.fn(async () => ({})),
    getSessions: vi.fn(async () => []),
    revokeSession: vi.fn(async () => undefined),
    ...overrides,
  } as Partial<UserResource>);
}

type SignInPatch = Partial<SignInResource> | ((params: Record<string, unknown>) => Partial<SignInResource>);

export function makeSignIn(
  instance: FakeInstance,
  handlers: Record<string, SignInPatch> = {},
): SignInResource {
  const apply = (name: string, params?: Record<string, unknown>) => {
    const handler = handlers[name];
    const patch = typeof handler === "function" ? handler(params ?? {}) : handler;
    if (patch) {
      Object.assign(signIn, patch);
      instance.emit();
    }
  };
  const signIn = fakeSignIn({
    id: "sia_1",
    status: "needs_identifier",
    identifier: null,
    supportedFirstFactors: [],
    supportedSecondFactors: [],
    createdSessionId: null,
    create: vi.fn(async function (this: SignInResource, params?: Record<string, unknown>) {
      apply("create", params);
      return this;
    }),
    prepareFirstFactor: vi.fn(async function (this: SignInResource, params?: Record<string, unknown>) {
      apply("prepareFirstFactor", params);
      return this;
    }),
    attemptFirstFactor: vi.fn(async function (this: SignInResource, params?: Record<string, unknown>) {
      apply("attemptFirstFactor", params);
      return this;
    }),
    prepareSecondFactor: vi.fn(async function (this: SignInResource, params?: Record<string, unknown>) {
      apply("prepareSecondFactor", params);
      return this;
    }),
    attemptSecondFactor: vi.fn(async function (this: SignInResource, params?: Record<string, unknown>) {
      apply("attemptSecondFactor", params);
      return this;
    }),
    resetPassword: vi.fn(async function (this: SignInResource, params?: Record<string, unknown>) {
      apply("resetPassword", params);
      return this;
    }),
    reload: vi.fn(async function (this: SignInResource) {
      return this;
    }),
    authenticateWithRedirect: vi.fn(async function (this: SignInResource) {
      return this;
    }),
    authenticateWithPasskey: vi.fn(async function (this: SignInResource) {
      return this;
    }),
  });
  instance.signIn = signIn;
  return signIn;
}

export function makeSignUp(
  instance: FakeInstance,
  handlers: Record<string, SignInPatch> = {},
): SignUpResource {
  const apply = (name: string, params?: Record<string, unknown>) => {
    const handler = handlers[name];
    const patch = typeof handler === "function" ? handler(params ?? {}) : handler;
    if (patch) {
      Object.assign(signUp, patch);
      instance.emit();
    }
  };
  const signUp = fakeSignUp({
    id: "sua_1",
    status: "missing_requirements",
    missingFields: [],
    unverifiedFields: [],
    create: vi.fn(async function (this: SignUpResource, params?: Record<string, unknown>) {
      apply("create", params);
      return this;
    }),
    prepareEmailAddressVerification: vi.fn(async function (this: SignUpResource, params?: Record<string, unknown>) {
      apply("prepareEmailAddressVerification", params);
      return this;
    }),
    attemptEmailAddressVerification: vi.fn(async function (this: SignUpResource, params?: Record<string, unknown>) {
      apply("attemptEmailAddressVerification", params);
      return this;
    }),
  });
  instance.signUp = signUp;
  return signUp;
}

export interface AuthHarness {
  instance: FakeInstance;
  session: ReturnType<typeof fakeSession>;
}

export function setupAuth(
  init: {
    user?: UserResource;
    environment?: EnvironmentResource;
    signedIn?: boolean;
    client?: FakeInstance["client"];
  } = {},
): AuthHarness {
  const session = fakeSession();
  const user = init.user ?? authUser();
  const instance = createFakeOrbitID({
    loaded: true,
    environment: init.environment ?? authEnvironment(),
    user: init.signedIn === false ? null : user,
    session: init.signedIn === false ? null : session,
  });
  instance.client =
    init.client ??
    ({
      id: "client_1",
      sessions: init.signedIn === false ? [] : [session],
      lastActiveSessionId: init.signedIn === false ? null : SESSION_ID,
      signIn: null,
      signUp: null,
    } as FakeInstance["client"]);
  return { instance, session };
}

export function renderAuth(ui: ReactNode, harness: AuthHarness, providerProps: Partial<OrbitIDProviderProps> = {}) {
  return renderWithProvider(ui, { instance: harness.instance, providerProps });
}

export function enterOtp(code: string): void {
  const input = document.querySelector("input[data-input-otp]");
  if (!(input instanceof HTMLInputElement)) throw new Error("OTP input not found");
  fireEvent.change(input, { target: { value: code } });
}
