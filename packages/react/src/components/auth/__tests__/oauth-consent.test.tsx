import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { OrbitID } from "@orbitid/js";
import { encodePublishableKey } from "@orbitid/shared";
import { OAuthConsent } from "../index";
import { apiOrigin } from "../_shared/api";
import type { OrbitIDInstance } from "../../../provider";
import { renderWithProvider, type FakeInstance } from "../../../__tests__/helpers";
import { authEnvironment, renderAuth, setupAuth } from "./fake-auth";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Minimal snake_case `/v1/client/environment` payload for a real `@orbitid/js` instance. */
function environmentWire() {
  const environment = authEnvironment();
  return {
    object: "environment",
    auth_config: {
      identification_requirements: [["email_address"]],
      first_factors: ["password"],
      second_factors: ["totp"],
      single_session_mode: true,
      sign_up_mode: "public",
      legal_consent_required: false,
      trusted_devices: { enabled: false, days: 30 },
      anonymous: { enabled: false },
    },
    user_settings: {
      attributes: {
        email_address: { enabled: true, required: true, used_for_first_factor: true, used_for_second_factor: false, verifications: ["email_code"], verify_at_sign_up: true },
        password: { enabled: true, required: true, used_for_first_factor: true, used_for_second_factor: false, verifications: [], verify_at_sign_up: false },
      },
      social: {},
      password_settings: { min_length: 8, max_length: 72, require_lowercase: false, require_uppercase: false, require_numbers: false, require_special_char: false },
      username_settings: { min_length: 4, max_length: 64 },
      sign_up: { mode: "public", progressive: true },
      actions: { delete_self: true, create_organization: true },
      passkey_settings: { allow_autofill: false, show_sign_in_button: false },
    },
    organization_settings: {
      enabled: false,
      max_allowed_memberships: 5,
      creation_enabled: true,
      domains_enabled: true,
      membership_requests_enabled: true,
      slug_enabled: true,
      force_organization_selection: false,
      creator_role: "org:admin",
      default_role: "org:member",
      max_created_organizations_per_user: null,
    },
    display_config: {
      application_name: environment.displayConfig.applicationName,
      logo_image_url: null,
      home_url: "/",
      support_email: null,
      terms_url: null,
      privacy_url: null,
      primary_color: "#111111",
      theme: "light",
      branded: true,
      captcha_enabled: false,
      captcha_provider: "none",
      captcha_site_key: "",
    },
  };
}

function clientWire() {
  return {
    object: "client",
    id: "client_1",
    sessions: [],
    sign_in: null,
    sign_up: null,
    last_active_session_id: null,
    cookie_expires_at: 0,
    created_at: 0,
    updated_at: 0,
  };
}

function realInstance(frontendApi: string): FakeInstance {
  return new OrbitID(encodePublishableKey(frontendApi)) as unknown as FakeInstance;
}

describe("OAuthConsent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the requesting application and requested scopes, then allows", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/oauth/consent_info")) {
        return jsonResponse({
          response: {
            application: { client_id: "oa_1", name: "Acme Analytics", logo_url: null },
            scopes: [
              { scope: "openid", description: "Confirm your identity" },
              { scope: "email", description: "See your email address" },
            ],
          },
        });
      }
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toMatchObject({ approve: true, client_id: "oa_1" });
      return jsonResponse({ response: { redirect_url: "/consent-done" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const harness = setupAuth();

    renderAuth(
      <OAuthConsent
        clientId="oa_1"
        scope="openid email"
        redirectUri="https://app.example.com/callback"
        state="xyz"
        frontendApiUrl="https://auth.example.com"
      />,
      harness,
    );

    expect(await screen.findByText("Acme Analytics")).toBeTruthy();
    expect(screen.getByText("Confirm your identity")).toBeTruthy();
    expect(screen.getByText(/See your email address/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/consent-done"));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("client_id=oa_1");
  });

  it("asks the Frontend API origin encoded in the publishable key, not the website origin", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith("/v1/client")) return jsonResponse({ response: clientWire(), client: clientWire() });
        if (url.endsWith("/v1/client/environment")) return jsonResponse({ response: environmentWire() });
        if (url.includes("/oauth/consent_info")) {
          return jsonResponse({
            response: {
              application: { client_id: "oa_1", name: "Acme Analytics", logo_url: null },
              scopes: [{ scope: "openid", description: "Confirm your identity" }],
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    // A real SDK instance: its /oauth requests used to fall back to the *website's* origin (relative
    // URLs against window.location), which is the Next page, not the OrbitID server.
    renderWithProvider(
      <OAuthConsent clientId="oa_1" scope="openid" redirectUri="https://app.example.com/callback" onAllow={() => {}} />,
      { instance: realInstance("http://localhost:4100") },
    );

    expect(await screen.findByText("Acme Analytics")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(requested.some((url) => url.startsWith("http://localhost:4100/oauth/consent"))).toBe(true));
    const consentCalls = requested.filter((url) => url.includes("/oauth/"));
    expect(consentCalls.length).toBeGreaterThan(0);
    for (const url of consentCalls) expect(url.startsWith("http://localhost:4100")).toBe(true);
    expect(consentCalls.some((url) => url.startsWith("/"))).toBe(false);
  });

  it("uses the SDK transport origin when the instance does not expose a publishable key, and denies there", async () => {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.includes("/oauth/consent_info")) {
          return jsonResponse({
            response: {
              application: { client_id: "oa_1", name: "Acme Analytics", logo_url: null },
              scopes: [],
            },
          });
        }
        return jsonResponse({ response: { redirect_url: "/denied" } });
      }),
    );
    const harness = setupAuth();
    Object.assign(harness.instance, { publishableKey: undefined, fapi: { baseUrl: "https://api.example.com/" } });

    renderAuth(
      <OAuthConsent clientId="oa_1" scope="openid" redirectUri="https://app.example.com/callback" />,
      harness,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/denied"));
    expect(requested.some((url) => url.startsWith("https://api.example.com/oauth/consent"))).toBe(true);
    expect(requested.every((url) => !url.startsWith("/"))).toBe(true);
  });

  it("resolves the origin from the transport first, then the key and the instance options", () => {
    const base = { frontendApi: undefined, frontendApiUrl: undefined, apiUrl: undefined, options: {} };
    expect(apiOrigin({ ...base, fapi: { baseUrl: "https://transport.example.com/" } } as unknown as OrbitIDInstance)).toBe(
      "https://transport.example.com",
    );
    expect(
      apiOrigin({ ...base, publishableKey: encodePublishableKey("https://key.example.com") } as unknown as OrbitIDInstance),
    ).toBe("https://key.example.com");
    expect(apiOrigin({ ...base, options: { frontendApi: "https://option.example.com" } } as unknown as OrbitIDInstance)).toBe(
      "https://option.example.com",
    );
    expect(apiOrigin(base as unknown as OrbitIDInstance)).toBe("");
  });

  it("shows the server's message when the decision is refused", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/oauth/consent_info")) {
        return jsonResponse({ response: { application: { client_id: "oa_1", name: "Acme Analytics", logo_url: null }, scopes: [] } });
      }
      return new Response(JSON.stringify({ errors: [{ code: "resource_not_found", message: "OAuth application not found" }] }), { status: 404, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAuth(
      <OAuthConsent clientId="oa_1" scope="openid" redirectUri="https://app.example.com/callback" frontendApiUrl="https://auth.example.com" />,
      setupAuth(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText(/not found/i, {}, { timeout: 5000 })).toBeTruthy();
  });

  it("reads the authorize request from redirect_url, which is all the server sends", async () => {
    const authorize = "/oauth/authorize?client_id=oa_1&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcallback&response_type=code&state=xyz&code_challenge=abc&code_challenge_method=S256&scope=openid";
    window.history.pushState({}, "", `/oauth-consent?client_id=oa_1&client_name=Acme&scope=openid&redirect_url=${encodeURIComponent(authorize)}`);
    try {
      const posted: unknown[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/oauth/consent_info")) {
          return jsonResponse({ response: { application: { client_id: "oa_1", name: "Acme", logo_url: null }, scopes: [{ scope: "openid", description: "Confirm your identity" }] } });
        }
        posted.push(JSON.parse(String(init?.body)));
        return jsonResponse({ response: { redirect_url: "/consent-done" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const harness = setupAuth();
      renderAuth(<OAuthConsent frontendApiUrl="https://auth.example.com" />, harness);
      fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
      await waitFor(() => expect(posted).toHaveLength(1));
      expect(posted[0]).toMatchObject({
        client_id: "oa_1", approve: true, redirect_uri: "https://app.example.com/callback", state: "xyz",
        code_challenge: "abc", code_challenge_method: "S256", response_type: "code",
      });
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("shows an invalid-request state without parameters", async () => {
    const harness = setupAuth();
    renderAuth(<OAuthConsent />, harness);
    expect(await screen.findByText(/invalid or has expired/i)).toBeTruthy();
  });
});
