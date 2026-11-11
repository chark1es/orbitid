import type {
  ClientJSON,
  EmailAddressJSON,
  EnvironmentJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  SessionJSON,
  SignInJSON,
  SignUpJSON,
  UserJSON,
} from "@orbitid/shared";
import { encodePublishableKey } from "@orbitid/shared";

export const API_URL = "https://api.example.com";
export const publishableKey = encodePublishableKey(API_URL, "test");

export interface RecordedCall {
  method: string;
  path: string;
  query: string;
  url: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
  init: RequestInit;
}

export interface MockResult {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type MockHandler = (call: RecordedCall) => MockResult | Promise<MockResult>;

function toResponse(result: MockResult): Response {
  const status = result.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(result.headers ?? {}),
    json: async () => result.body,
  } as unknown as Response;
}

/** Records every Frontend API call and answers from a per-test routing function. */
export class ApiMock {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly handler: MockHandler) {}

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    let body: Record<string, unknown> | undefined;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    const call: RecordedCall = {
      method: init.method ?? "GET",
      path: url.pathname,
      query: url.search,
      url: input,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
      init,
    };
    this.calls.push(call);
    return toResponse(await this.handler(call));
  };

  lastCall(method: string, path: string): RecordedCall | undefined {
    return [...this.calls].reverse().find((call) => call.method === method && call.path === path);
  }

  countCalls(method: string, path: string): number {
    return this.calls.filter((call) => call.method === method && call.path === path).length;
  }
}

export function errorBody(code: string, message: string, traceId = "trace_1"): MockResult {
  return { status: 422, body: { errors: [{ code, message, long_message: message }], trace_id: traceId } };
}

export function fakeJwt(claims: Record<string, unknown> = {}, options: { lifetimeSeconds?: number; now?: number } = {}): string {
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const payload = {
    iss: API_URL,
    sub: "user_1",
    sid: "sess_1",
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + (options.lifetimeSeconds ?? 60),
    ...claims,
  };
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

export function emailJSON(overrides: Partial<EmailAddressJSON> = {}): EmailAddressJSON {
  const now = Date.now();
  return {
    object: "email_address",
    id: "idn_e1",
    email_address: "ada@example.com",
    verification: { status: "verified", strategy: "email_code", attempts: null, expire_at: null },
    linked_to: [],
    reserved: false,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function userJSON(overrides: Partial<UserJSON> = {}): UserJSON {
  const now = Date.now();
  return {
    object: "user",
    id: "user_1",
    external_id: null,
    username: null,
    first_name: "Ada",
    last_name: "Lovelace",
    image_url: "https://img.example.com/ada.png",
    has_image: false,
    primary_email_address_id: "idn_e1",
    primary_phone_number_id: null,
    password_enabled: true,
    totp_enabled: false,
    backup_code_enabled: false,
    two_factor_enabled: false,
    passkeys: [],
    email_addresses: [emailJSON()],
    phone_numbers: [],
    external_accounts: [],
    public_metadata: {},
    unsafe_metadata: {},
    is_anonymous: false,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: 5,
    delete_self_enabled: true,
    create_organization_enabled: true,
    create_organizations_limit: null,
    roles: [],
    role_permissions: [],
    last_sign_in_at: now,
    last_active_at: now,
    legal_accepted_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function sessionJSON(
  overrides: Partial<SessionJSON> & { user?: UserJSON | null } = {},
): SessionJSON {
  const now = Date.now();
  return {
    object: "session",
    id: "sess_1",
    status: "active",
    sign_in_method: null,
    expire_at: now + 86_400_000,
    abandon_at: now + 86_400_000,
    last_active_at: now,
    last_active_organization_id: null,
    actor: null,
    user: userJSON(),
    public_user_data: { first_name: "Ada", last_name: "Lovelace", image_url: "", has_image: false, identifier: "ada@example.com", user_id: "user_1" },
    factor_verification_age: [0, -1],
    last_active_token: null,
    latest_activity: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function clientJSON(
  overrides: Partial<ClientJSON> = {},
): ClientJSON {
  const now = Date.now();
  const sessions = overrides.sessions ?? [];
  return {
    object: "client",
    id: "client_1",
    sessions,
    sign_in: null,
    sign_up: null,
    last_active_session_id: sessions[0]?.id ?? null,
    cookie_expires_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function signInJSON(overrides: Partial<SignInJSON> = {}): SignInJSON {
  return {
    object: "sign_in",
    id: "sia_1",
    status: "needs_first_factor",
    supported_identifiers: ["email_address"],
    supported_first_factors: [{ strategy: "password" }],
    supported_second_factors: null,
    first_factor_verification: { status: "unverified", strategy: "password", attempts: 0, expire_at: null },
    second_factor_verification: null,
    identifier: "ada@example.com",
    user_data: { first_name: "Ada", last_name: "Lovelace", image_url: "", has_image: false },
    created_session_id: null,
    abandon_at: Date.now() + 3_600_000,
    ...overrides,
  };
}

export function signUpJSON(overrides: Partial<SignUpJSON> = {}): SignUpJSON {
  return {
    object: "sign_up",
    id: "sua_1",
    status: "missing_requirements",
    required_fields: ["email_address", "password"],
    optional_fields: ["first_name", "last_name"],
    missing_fields: [],
    unverified_fields: ["email_address"],
    verifications: { email_address: { status: "unverified", strategy: "email_code", attempts: 0, expire_at: null }, phone_number: null, external_account: null, web3_wallet: null },
    username: null,
    email_address: "new@example.com",
    phone_number: null,
    first_name: null,
    last_name: null,
    password_enabled: true,
    unsafe_metadata: {},
    public_metadata: {},
    custom_action: false,
    external_id: null,
    created_session_id: null,
    created_user_id: null,
    abandon_at: Date.now() + 3_600_000,
    legal_accepted_at: null,
    ...overrides,
  };
}

export function organizationJSON(overrides: Partial<OrganizationJSON> = {}): OrganizationJSON {
  const now = Date.now();
  return {
    object: "organization",
    id: "org_1",
    name: "Acme",
    slug: "acme",
    image_url: "https://img.example.com/acme.png",
    has_image: false,
    members_count: 2,
    pending_invitations_count: 0,
    max_allowed_memberships: 5,
    admin_delete_enabled: true,
    public_metadata: {},
    created_by: "user_1",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function membershipJSON(overrides: Partial<OrganizationMembershipJSON> = {}): OrganizationMembershipJSON {
  const now = Date.now();
  return {
    object: "organization_membership",
    id: "orgmem_1",
    role: "org:admin",
    role_name: "Admin",
    permissions: ["org:sys_memberships:manage"],
    public_metadata: {},
    organization: organizationJSON(),
    public_user_data: { user_id: "user_2", first_name: "Grace", last_name: "Hopper", image_url: "", has_image: false, identifier: "grace@example.com" },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

export function environmentJSON(overrides: Partial<EnvironmentJSON> = {}): EnvironmentJSON {
  return {
    object: "environment",
    auth_config: {
      identification_requirements: [["email_address"]],
      first_factors: ["password", "email_code", "oauth_google"],
      second_factors: ["totp"],
      single_session_mode: false,
      sign_up_mode: "public",
      legal_consent_required: false,
      trusted_devices: { enabled: false, days: 30 },
      anonymous: { enabled: false },
    },
    user_settings: {
      attributes: {
        emailAddress: { enabled: true, required: true, used_for_first_factor: true, used_for_second_factor: false, verifications: ["email_code"], verify_at_sign_up: true },
        username: { enabled: true, required: false, used_for_first_factor: false, used_for_second_factor: false, verifications: [], verify_at_sign_up: false },
        password: { enabled: true, required: true, used_for_first_factor: true, used_for_second_factor: false, verifications: [], verify_at_sign_up: false },
        authenticatorApp: { enabled: true, required: false, used_for_first_factor: false, used_for_second_factor: true, verifications: [], verify_at_sign_up: false },
      },
      social: {
        google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logo_url: "https://logo.example.com/google.svg" },
        github: { enabled: false, name: "GitHub", strategy: "oauth_github", authenticatable: true, logo_url: "" },
      },
      password_settings: { min_length: 10, max_length: 72, require_lowercase: true, require_uppercase: false, require_numbers: true, require_special_char: false },
      username_settings: { min_length: 4, max_length: 32 },
      sign_up: { mode: "public", progressive: true },
      actions: { delete_self: true, create_organization: true },
      passkey_settings: { allow_autofill: true, show_sign_in_button: false },
    },
    organization_settings: {
      enabled: true,
      max_allowed_memberships: 5,
      max_created_organizations_per_user: 3,
      creation_enabled: true,
      domains_enabled: true,
      membership_requests_enabled: true,
      slug_enabled: true,
      force_organization_selection: false,
      creator_role: "org:admin",
      default_role: "org:member",
    },
    display_config: {
      application_name: "Acme App",
      logo_image_url: null,
      home_url: "https://app.example.com",
      support_email: null,
      terms_url: null,
      privacy_url: null,
      primary_color: "#6366f1",
      theme: "light",
      branded: false,
      captcha_enabled: false,
      captcha_provider: "none",
      captcha_site_key: "",
    },
    ...overrides,
  };
}

export function clearCookies(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
}

export function cookieValue(name: string): string | null {
  const match = document.cookie.split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}
