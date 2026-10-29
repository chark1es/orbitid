import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import Page from "./settings-email-sms";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

describe("email & SMS settings", () => {
  it("shows the effective provider and warns when mail only reaches the server log", async () => {
    mockApi({ instance: instanceBody((settings) => { settings.email.provider = "console"; }) });
    renderPage(<Page />);

    expect(await screen.findByText("Email is printed to the server log, not delivered")).toBeTruthy();
    expect(screen.getAllByText(/Print to server log/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Resend API key")).toBeNull();
  });

  it("derives the effective provider from automatic mode", async () => {
    mockApi({
      instance: instanceBody((settings) => {
        settings.email.provider = "auto";
        settings.email.resendApiKey = "••••";
      }),
    });
    renderPage(<Page />);

    expect(await screen.findAllByText("Resend")).not.toHaveLength(0);
    expect(screen.queryByText("Email is printed to the server log, not delivered")).toBeNull();
  });

  it("marks a stored secret as Set, keeps it on save, and replaces it only when typed", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.email.provider = "resend";
        settings.email.resendApiKey = "••••";
      }),
    });
    renderPage(<Page />);

    const field = (await screen.findByLabelText(/Resend API key/)) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toMatch(/leave blank to keep/i);
    expect(screen.getByText("Set")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Code length/), { target: { value: "8" } });
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH");
      expect(patch?.body).toEqual({ email: { codeLength: 8 } });
    });

    fireEvent.change(field, { target: { value: "re_live_replacement" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    await waitFor(() => {
      const patches = calls.filter((call) => call.method === "PATCH");
      expect(patches.at(-1)?.body).toEqual({ email: { resendApiKey: "re_live_replacement" } });
    });
  });

  it("blocks saving an invalid from address with the reason", async () => {
    const calls = mockApi();
    renderPage(<Page />);

    const field = await screen.findByLabelText(/From address/);
    fireEvent.change(field, { target: { value: "not-an-address" } });

    expect((await screen.findAllByText(/From address must contain an email address/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("reports a successful test email with the transport the server used", async () => {
    const calls = mockApi({ emailTest: { status: 200, body: { provider: "smtp", ok: true } } });
    renderPage(<Page />);

    fireEvent.change(await screen.findByLabelText("Test recipient"), { target: { value: "ops@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));

    expect(await screen.findByText(/Delivered to/)).toBeTruthy();
    expect(screen.getByText("SMTP")).toBeTruthy();

    const call = calls.find((item) => item.url.endsWith("/v1/instance/email_test"));
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ to: "ops@example.com" });
  });

  it("shows the server's safe failure message when delivery fails", async () => {
    mockApi({
      emailTest: {
        status: 502,
        body: { errors: [{ code: "email_delivery_failed", message: "Resend answered 403: domain not verified" }] },
      },
    });
    renderPage(<Page />);

    fireEvent.change(await screen.findByLabelText("Test recipient"), { target: { value: "ops@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /send test email/i }));

    expect(await screen.findByText(/The test email was not delivered/)).toBeTruthy();
    expect(screen.getByText(/domain not verified/)).toBeTruthy();
    expect(screen.getByText(/safe to share/)).toBeTruthy();
  });

  it("keeps the SMS section working with a masked Twilio token", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.sms.provider = "twilio";
        settings.sms.twilioAccountSid = "AC123";
        settings.sms.twilioFrom = "+15551234567";
        settings.sms.twilioAuthToken = "••••";
      }),
    });
    renderPage(<Page />);

    const token = (await screen.findByLabelText(/Auth token/)) as HTMLInputElement;
    expect(token.value).toBe("");
    expect(screen.getByLabelText(/Account SID/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Sender number/), { target: { value: "+15550000000" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ sms: { twilioFrom: "+15550000000" } });
    });
  });
});
