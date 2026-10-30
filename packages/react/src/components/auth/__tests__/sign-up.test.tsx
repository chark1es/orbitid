import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SignUp } from "../index";
import { authEnvironment, authUser, enterOtp, makeSignUp, renderAuth, setupAuth, SESSION_ID } from "./fake-auth";
import { fakeSession } from "../../../__tests__/helpers";

describe("SignUp", () => {
  it("submits the required fields and verifies the email", async () => {
    const harness = setupAuth({ signedIn: false });
    const signUp = makeSignUp(harness.instance, {
      create: {
        status: "missing_requirements",
        emailAddress: "new@example.com",
        unverifiedFields: ["email_address"],
        missingFields: [],
        verifications: {
          emailAddress: { status: "unverified", strategy: "email_code", attempts: 0, expireAt: null },
        },
      },
      prepareEmailAddressVerification: {
        status: "missing_requirements",
        unverifiedFields: ["email_address"],
      },
      attemptEmailAddressVerification: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderAuth(<SignUp routing="virtual" forceRedirectUrl="/welcome" />, harness);

    fireEvent.change(await screen.findByLabelText(/First name/), { target: { value: "Grace" } });
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Sup3r-Secret!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp.create).toHaveBeenCalled());
    expect(signUp.create).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAddress: "new@example.com",
        password: "Sup3r-Secret!",
        firstName: "Grace",
      }),
    );

    await waitFor(() => expect(document.querySelector("input[data-input-otp]")).toBeTruthy());
    expect(signUp.prepareEmailAddressVerification).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "email_code" }),
    );
    enterOtp("424242");
    fireEvent.click(screen.getByRole("button", { name: "Verify email" }));

    await waitFor(() => expect(signUp.attemptEmailAddressVerification).toHaveBeenCalledWith(expect.objectContaining({ code: "424242", strategy: "email_code" })));
    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
    expect(harness.instance.navigations.at(-1)?.to).toBe("/welcome");
  });

  it("marks a missing required field as invalid and ties its message to the input", async () => {
    const harness = setupAuth({ signedIn: false });
    const signUp = makeSignUp(harness.instance, {});
    renderAuth(<SignUp routing="virtual" />, harness);

    const email = await screen.findByLabelText(/Email address/);
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(email.getAttribute("aria-invalid")).toBe("true"));
    const describedBy = email.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.getAttribute("role")).toBe("alert");
    expect(signUp.create).not.toHaveBeenCalled();
  });

  it("enrols a second factor when required MFA leaves the session pending", async () => {
    const harness = setupAuth({ signedIn: false });
    const user = authUser({
      verifyTOTP: vi.fn(async () => ({ verified: true, backupCodes: ["A1B2-C3D4"] })),
    });
    harness.instance.user = user;
    const signUp = makeSignUp(harness.instance, {
      create: {
        status: "missing_requirements",
        emailAddress: "new@example.com",
        unverifiedFields: ["email_address"],
        missingFields: [],
        verifications: {
          emailAddress: { status: "unverified", strategy: "email_code", attempts: 0, expireAt: null },
        },
      },
      prepareEmailAddressVerification: {
        status: "missing_requirements",
        unverifiedFields: ["email_address"],
      },
      attemptEmailAddressVerification: () => {
        const pending = fakeSession({ id: SESSION_ID, status: "pending" });
        harness.instance.session = pending;
        harness.instance.client = {
          id: "client_1",
          sessions: [pending],
          lastActiveSessionId: SESSION_ID,
        } as typeof harness.instance.client;
        return { status: "complete", createdSessionId: SESSION_ID };
      },
    });
    renderAuth(<SignUp routing="virtual" forceRedirectUrl="/welcome" />, harness);

    fireEvent.change(await screen.findByLabelText(/First name/), { target: { value: "Grace" } });
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Sup3r-Secret!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(document.querySelector("input[data-input-otp]")).toBeTruthy());
    act(() => enterOtp("424242"));

    expect(await screen.findByText("Set up two-factor authentication")).toBeTruthy();
    expect(signUp.create).toHaveBeenCalled();
    expect(harness.instance.setActiveCalls).toHaveLength(0);
    expect(harness.instance.navigations.map((entry) => entry.to)).not.toContain("/welcome");

    act(() => enterOtp("123456"));
    await waitFor(() => expect(user.verifyTOTP).toHaveBeenCalledWith({ code: "123456" }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(harness.instance.setActiveCalls).toHaveLength(1));
    await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/welcome"));
  });

  it("shows a legal consent checkbox when required", async () => {
    const environment = authEnvironment();
    environment.authConfig.legalConsentRequired = true;
    environment.displayConfig.termsUrl = "https://example.com/terms";
    environment.displayConfig.privacyUrl = "https://example.com/privacy";
    const harness = setupAuth({ signedIn: false, environment });
    makeSignUp(harness.instance);
    renderAuth(<SignUp routing="virtual" />, harness);

    const consent = await screen.findByRole("checkbox", { name: /I agree to the/ });
    expect(consent).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Sup3r-Secret!" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("This field is required.")).toBeTruthy();
  });

  it("renders the waitlist when the instance is in waitlist mode", async () => {
    const environment = authEnvironment();
    environment.authConfig.signUpMode = "waitlist";
    environment.userSettings.signUp = { mode: "waitlist", progressive: true };
    const harness = setupAuth({ signedIn: false, environment });
    renderAuth(<SignUp routing="virtual" />, harness);
    expect(await screen.findByText("Join the waitlist")).toBeTruthy();
    expect(screen.getByLabelText(/Email address/)).toBeTruthy();
  });

  it("renders the captcha slot when the environment enables it", async () => {
    const environment = authEnvironment();
    environment.displayConfig.captchaEnabled = true;
    environment.displayConfig.captchaProvider = "turnstile";
    environment.displayConfig.captchaSiteKey = "site-key";
    const harness = setupAuth({ signedIn: false, environment });
    makeSignUp(harness.instance);
    renderAuth(<SignUp routing="virtual" />, harness);
    await waitFor(() => expect(screen.getByTestId("captcha-widget")).toBeTruthy());
  });

  it("renders the restricted message in restricted mode", async () => {
    const environment = authEnvironment();
    environment.authConfig.signUpMode = "restricted";
    environment.userSettings.signUp = { mode: "restricted", progressive: true };
    const harness = setupAuth({ signedIn: false, environment });
    renderAuth(<SignUp routing="virtual" signInUrl="/login" />, harness);
    expect(await screen.findByText(/Sign up is restricted/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(harness.instance.navigations.at(-1)?.to).toBe("/login");
  });
});
