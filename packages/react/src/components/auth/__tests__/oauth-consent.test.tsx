import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { OAuthConsent } from "../index";
import { renderAuth, setupAuth } from "./fake-auth";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
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
