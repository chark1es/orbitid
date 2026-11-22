import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { EmailSetupBanner, EmailSetupNotice } from "./email-setup-notice";
import { parseEmailDelivery } from "../../lib/email-delivery";
import { instanceBody, mockApi, renderPage } from "../../pages/_config/__tests__/harness";

function withDelivery(provider: string | undefined) {
  return provider === undefined ? instanceBody() : { ...instanceBody(), email_delivery: { provider } };
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("parseEmailDelivery", () => {
  it("reads the server-resolved transport and ignores anything else", () => {
    expect(parseEmailDelivery({ email_delivery: { provider: "console" } }).provider).toBe("console");
    expect(parseEmailDelivery({ email_delivery: { provider: "smtp" } }).provider).toBe("smtp");
    expect(parseEmailDelivery({ email_delivery: { provider: "carrier-pigeon" } }).provider).toBeNull();
    expect(parseEmailDelivery({}).provider).toBeNull();
  });
});

describe("email setup prompts", () => {
  it("sends the operator to Email & SMS when the server delivers no mail", async () => {
    mockApi({ instance: withDelivery("console") });
    renderPage(<EmailSetupBanner />);
    const link = await screen.findByRole("link", { name: /set up email/i });
    expect(link.getAttribute("href")).toBe("/settings/email-sms");
  });

  it("stays quiet when mail is delivered, including through environment variables", async () => {
    const calls = mockApi({ instance: withDelivery("smtp") });
    renderPage(<EmailSetupBanner />);
    await waitFor(() => expect(calls.some((call) => call.url.includes("/v1/instance"))).toBe(true));
    expect(screen.queryByRole("link", { name: /set up email/i })).toBeNull();
  });

  it("stays quiet against an older server that does not report delivery", async () => {
    const calls = mockApi({ instance: withDelivery(undefined) });
    renderPage(<EmailSetupNotice />);
    await waitFor(() => expect(calls.some((call) => call.url.includes("/v1/instance"))).toBe(true));
    expect(screen.queryByText(/email delivery is not set up/i)).toBeNull();
  });

  it("can be hidden for the session", async () => {
    mockApi({ instance: withDelivery("console") });
    renderPage(<EmailSetupBanner />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide for this session" }));
    expect(screen.queryByRole("link", { name: /set up email/i })).toBeNull();
    expect(sessionStorage.getItem("orbitid-email-banner-dismissed")).toBe("1");
  });
});
