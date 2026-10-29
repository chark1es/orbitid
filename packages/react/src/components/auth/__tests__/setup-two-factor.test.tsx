import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SetupTwoFactor } from "../setup-two-factor";
import { authEnvironment, authUser, enterOtp, renderAuth, setupAuth, SESSION_ID } from "./fake-auth";
import { fakeSession } from "../../../__tests__/helpers";

const BACKUP_CODES = Array.from({ length: 10 }, (_, index) => `CODE-${index}0`);

function pendingHarness(options: { user?: ReturnType<typeof authUser> } = {}) {
  const harness = setupAuth();
  const session = fakeSession({ id: SESSION_ID, status: "pending" });
  harness.instance.session = session;
  harness.instance.client = {
    id: "client_1",
    sessions: [session],
    lastActiveSessionId: SESSION_ID,
  } as typeof harness.instance.client;
  if (options.user) harness.instance.user = options.user;
  harness.instance.emit();
  return harness;
}

function totpUser() {
  return authUser({
    createTOTP: vi.fn(async () => ({
      secret: "JBSWY3DPEHPK3PXP",
      uri: "otpauth://totp/x",
      qrCode: "data:image/png;base64,AAAA",
    })),
    verifyTOTP: vi.fn(async () => ({ verified: true, backupCodes: BACKUP_CODES })),
  });
}

describe("<SetupTwoFactor />", () => {
  it("starts TOTP, verifies the code, shows the backup codes and activates the pending session", async () => {
    const user = totpUser();
    const harness = pendingHarness({ user });
    renderAuth(<SetupTwoFactor redirectUrl="/dashboard" />, harness);

    expect(await screen.findByText("Set up two-factor authentication")).toBeTruthy();
    expect(user.createTOTP).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId("setup-two-factor-qr")).getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(screen.getByTestId("setup-two-factor-secret").textContent).toBe("JBSWY3DPEHPK3PXP");
    expect(screen.getByRole("button", { name: "Copy secret key" })).toBeTruthy();
    expect(harness.instance.setActiveCalls).toHaveLength(0);

    act(() => enterOtp("123456"));
    await waitFor(() => expect(user.verifyTOTP).toHaveBeenCalledWith({ code: "123456" }));

    const codes = await screen.findAllByTestId("setup-two-factor-code");
    expect(codes).toHaveLength(10);
    expect(codes[0]?.textContent).toBe(BACKUP_CODES[0]);
    expect(screen.getByRole("button", { name: "Download codes" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(harness.instance.setActiveCalls).toHaveLength(1));
    const activated = harness.instance.setActiveCalls[0]?.session;
    expect(typeof activated === "string" ? activated : activated?.id).toBe(SESSION_ID);
    await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/dashboard"));
  });

  it("keeps a wrong code on the setup step with a localized error", async () => {
    const user = totpUser();
    user.verifyTOTP = vi.fn(async () => {
      throw { errors: [{ code: "form_code_incorrect", message: "Incorrect code" }] };
    });
    const harness = pendingHarness({ user });
    renderAuth(<SetupTwoFactor />, harness);

    expect(await screen.findByTestId("setup-two-factor-qr")).toBeTruthy();
    act(() => enterOtp("000000"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Incorrect code. Please try again.");
    expect(screen.queryAllByTestId("setup-two-factor-code")).toHaveLength(0);
    expect(harness.instance.setActiveCalls).toHaveLength(0);
  });

  it("reports an expired verification and keeps the step open", async () => {
    const user = totpUser();
    user.verifyTOTP = vi.fn(async () => {
      throw { errors: [{ code: "verification_expired", message: "Expired" }] };
    });
    const harness = pendingHarness({ user });
    renderAuth(<SetupTwoFactor />, harness);

    expect(await screen.findByTestId("setup-two-factor-qr")).toBeTruthy();
    act(() => enterOtp("123456"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/expired/i);
    expect(harness.instance.setActiveCalls).toHaveLength(0);
  });

  it("offers the phone option only when the environment supports phone second factors", async () => {
    const user = totpUser();

    const withoutPhone = pendingHarness({ user });
    const first = renderAuth(<SetupTwoFactor />, withoutPhone);
    expect(await screen.findByTestId("setup-two-factor-qr")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use a phone number instead" })).toBeNull();
    first.unmount();

    const environment = authEnvironment();
    environment.userSettings.attributes.phoneNumber = {
      enabled: true,
      required: false,
      usedForFirstFactor: false,
      usedForSecondFactor: true,
      verifications: ["phone_code"],
      verifyAtSignUp: false,
    };
    const harness = pendingHarness({ user });
    harness.instance.environment = environment;
    harness.instance.emit();
    renderAuth(<SetupTwoFactor />, harness);

    fireEvent.click(await screen.findByRole("button", { name: "Use a phone number instead" }));
    expect(await screen.findByLabelText("Phone number", { selector: "input" })).toBeTruthy();
  });

  it("enrols a phone number and activates the session", async () => {
    const environment = authEnvironment();
    environment.userSettings.attributes.phoneNumber = {
      enabled: true,
      required: false,
      usedForFirstFactor: false,
      usedForSecondFactor: true,
      verifications: ["phone_code"],
      verifyAtSignUp: false,
    };
    const phone = {
      id: "idn_p1",
      phoneNumber: "+14155550123",
      prepareVerification: vi.fn(async () => phone),
      attemptVerification: vi.fn(async () => phone),
      makeDefaultSecondFactor: vi.fn(async () => phone),
    };
    const user = authUser({ createPhoneNumber: vi.fn(async () => phone) });
    const harness = pendingHarness({ user });
    harness.instance.environment = environment;
    harness.instance.emit();

    renderAuth(<SetupTwoFactor redirectUrl="/home" />, harness);
    fireEvent.click(await screen.findByRole("button", { name: "Use a phone number instead" }));
    fireEvent.change(screen.getByLabelText("Phone number", { selector: "input" }), {
      target: { value: "4155550123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await waitFor(() => expect(user.createPhoneNumber).toHaveBeenCalledWith({ phoneNumber: "+14155550123" }));
    act(() => enterOtp("654321"));
    await waitFor(() => expect(phone.attemptVerification).toHaveBeenCalledWith({ code: "654321" }));
    await waitFor(() => expect(phone.makeDefaultSecondFactor).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(harness.instance.setActiveCalls).toHaveLength(1));
    await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/home"));
  });
});
