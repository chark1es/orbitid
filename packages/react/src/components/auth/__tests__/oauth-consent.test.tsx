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
      expect(JSON.parse(String(init?.body))).toMatchObject({ consent: "allow", client_id: "oa_1" });
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

  it("shows an invalid-request state without parameters", async () => {
    const harness = setupAuth();
    renderAuth(<OAuthConsent />, harness);
    expect(await screen.findByText(/invalid or has expired/i)).toBeTruthy();
  });
});
