import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SignIn } from "../index";
import { authEnvironment, authUser, enterOtp, makeSignIn, renderAuth, setupAuth, SESSION_ID } from "./fake-auth";
import { fakeSession } from "../../../__tests__/helpers";

function renderSignIn(
  harness: ReturnType<typeof setupAuth>,
  props: Partial<Parameters<typeof SignIn>[0]> = {},
) {
  return renderAuth(<SignIn routing="virtual" {...props} />, harness);
}

describe("SignIn", () => {
  it("signs in automatically from a backend ticket link (?__orbit_ticket=)", async () => {
    window.history.pushState({}, "", "/sign-in?__orbit_ticket=tok_123");
    try {
      const harness = setupAuth({ signedIn: false });
      const signIn = makeSignIn(harness.instance, {
        create: { status: "complete", createdSessionId: SESSION_ID },
      });
      renderSignIn(harness, { forceRedirectUrl: "/dashboard" });

      await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
      expect(signIn.create).toHaveBeenCalledTimes(1);
      expect(signIn.create).toHaveBeenCalledWith({ strategy: "ticket", ticket: "tok_123" });
      expect(harness.instance.setActiveCalls[0]?.session).toBe(SESSION_ID);
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("keeps the signal-red focus ring instead of tinting it with the brand colour", async () => {
    const harness = setupAuth({ signedIn: false });
    makeSignIn(harness.instance);
    renderSignIn(harness);

    const card = document.querySelector('[data-orbit-component="auth-card"]') as HTMLElement;
    expect(card).toBeTruthy();
    // DESIGN.md declares the 2px ring once, in @orbitid/ui/styles.css (--ring is signal red). A brand
    // primary colour may style buttons, but it must not replace the focus ring.
    expect(card.style.getPropertyValue("--ring")).toBe("");
  });

  it("keeps the footer sign-up action on the same text size as its sentence", async () => {
    const harness = setupAuth({ signedIn: false });
    makeSignIn(harness.instance);
    renderSignIn(harness);

    const action = await screen.findByRole("button", { name: "Sign up" });
    const sentence = action.closest("p");
    expect(sentence?.className).toContain("text-sm");
    expect(action.className).toContain("text-sm");
  });

  it("tells the visitor when a magic link was opened in the wrong browser", async () => {
    window.history.pushState({}, "", "/sign-in?__orbit_status=different_browser");
    try {
      const harness = setupAuth({ signedIn: false });
      renderSignIn(harness);
      expect(await screen.findByText(/Open the link in the browser where you started signing in/)).toBeTruthy();
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("signs in with a password and redirects", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: { status: "needs_first_factor", supportedFirstFactors: [{ strategy: "password" }], identifier: "ada@example.com" },
      attemptFirstFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness, { forceRedirectUrl: "/dashboard" });

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    const password = await screen.findByLabelText(/^Password/);
    expect(signIn.create).toHaveBeenCalledWith(expect.objectContaining({ identifier: "ada@example.com" }));
    fireEvent.change(password, { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
    expect(harness.instance.setActiveCalls[0]?.session).toBe(SESSION_ID);
    expect(harness.instance.navigations.at(-1)?.to).toBe("/dashboard");
  });

  it("enrols a second factor for a pending session instead of reporting success", async () => {
    const harness = setupAuth({ signedIn: false });
    const user = authUser({
      createTOTP: vi.fn(async () => ({
        secret: "JBSWY3DPEHPK3PXP",
        uri: "otpauth://totp/x",
        qrCode: "data:image/png;base64,AAAA",
      })),
      verifyTOTP: vi.fn(async () => ({
        verified: true,
        backupCodes: Array.from({ length: 10 }, (_, index) => `CODE-${index}0`),
      })),
    });
    harness.instance.user = user;
    makeSignIn(harness.instance, {
      create: {
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
        identifier: "ada@example.com",
      },
      attemptFirstFactor: () => {
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
    renderSignIn(harness, { forceRedirectUrl: "/dashboard" });

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Set up two-factor authentication")).toBeTruthy();
    expect(await screen.findByTestId("setup-two-factor-qr")).toBeTruthy();
    expect(harness.instance.setActiveCalls).toHaveLength(0);
    expect(harness.instance.navigations.map((entry) => entry.to)).not.toContain("/dashboard");

    act(() => enterOtp("123456"));
    await waitFor(() => expect(user.verifyTOTP).toHaveBeenCalledWith({ code: "123456" }));
    expect(await screen.findAllByTestId("setup-two-factor-code")).toHaveLength(10);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(harness.instance.setActiveCalls).toHaveLength(1));
    const activated = harness.instance.setActiveCalls[0]?.session;
    expect(typeof activated === "string" ? activated : activated?.id).toBe(SESSION_ID);
    await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/dashboard"));
  });

  it("keeps the redirect target when routing by path", async () => {
    const harness = setupAuth({ signedIn: false });
    makeSignIn(harness.instance, {
      create: { status: "needs_first_factor", supportedFirstFactors: [{ strategy: "password" }] },
      attemptFirstFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderAuth(<SignIn routing="path" path="/sign-in" forceRedirectUrl="/dashboard" />, harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
    const paths = harness.instance.navigations.map((entry) => entry.to);
    expect(paths).toContain("/sign-in/factor-one");
    expect(paths.at(-1)).toBe("/dashboard");
    expect(paths).not.toContain("/sign-in/success");
  });

  it("maps API errors to localized messages", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: { status: "needs_first_factor", supportedFirstFactors: [{ strategy: "password" }] },
    });
    (signIn.attemptFirstFactor as ReturnType<typeof vi.fn>).mockRejectedValueOnce({
      errors: [{ code: "form_password_incorrect", message: "Bad password" }],
    });
    renderSignIn(harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Password is incorrect");
    expect(harness.instance.setActiveCalls).toHaveLength(0);
  });

  it("sends and verifies an email code", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_first_factor",
        identifier: "ada@example.com",
        supportedFirstFactors: [{ strategy: "email_code", emailAddressId: "idn_e1" }],
      },
      prepareFirstFactor: {
        status: "needs_first_factor",
        firstFactorVerification: { status: "unverified", strategy: "email_code", expireAt: null },
      },
      attemptFirstFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness, { fallbackRedirectUrl: "/home" });

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("heading", { name: "Check your email" }).catch(() => undefined);
    expect(document.querySelector("input[data-input-otp]")).toBeTruthy();
    expect(signIn.prepareFirstFactor).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "email_code", emailAddressId: "idn_e1" }),
    );
    act(() => enterOtp("123456"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(signIn.attemptFirstFactor).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "email_code", code: "123456" }),
    ));
    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
    expect(harness.instance.navigations.at(-1)?.to).toBe("/home");
  });

  it("resets a forgotten password with a code", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_first_factor",
        identifier: "ada@example.com",
        supportedFirstFactors: [{ strategy: "reset_password_email_code", emailAddressId: "idn_e1" }],
      },
      prepareFirstFactor: { status: "needs_first_factor" },
      attemptFirstFactor: { status: "needs_new_password" },
      resetPassword: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness);

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));

    await waitFor(() => expect(document.querySelector("input[data-input-otp]")).toBeTruthy());
    act(() => enterOtp("111111"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    const newPassword = await screen.findByLabelText(/New password/);
    fireEvent.change(newPassword, { target: { value: "N3w-Password!23" } });
    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: "N3w-Password!23" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    await waitFor(() => expect(signIn.resetPassword).toHaveBeenCalledWith(
      expect.objectContaining({ password: "N3w-Password!23" }),
    ));
    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
  });

  it("uses the provider localization override", async () => {
    const harness = setupAuth({ signedIn: false });
    makeSignIn(harness.instance);
    renderAuth(<SignIn routing="virtual" />, harness, {
      localization: { signIn: { start: { title: "Accedi a {{applicationName}}" } } },
    });
    expect(await screen.findByText("Accedi a Acme")).toBeTruthy();
  });

  it("applies appearance element class overrides", async () => {
    const harness = setupAuth({ signedIn: false });
    makeSignIn(harness.instance);
    renderAuth(<SignIn routing="virtual" />, harness, {
      appearance: { elements: { card: "custom-card", formButtonPrimary: "custom-primary" } },
    });
    const card = await screen.findByText(/Welcome back/i);
    expect(card.closest(".custom-card")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" }).className).toContain("custom-primary");
  });

  it("shows the development-mode banner from the environment", async () => {
    const environment = authEnvironment();
    (environment.displayConfig as unknown as Record<string, unknown>).developmentMode = true;
    const harness = setupAuth({ signedIn: false, environment });
    makeSignIn(harness.instance);
    renderSignIn(harness);
    expect(await screen.findByText(/Development mode/i)).toBeTruthy();
  });

  it("renders social buttons for enabled providers", async () => {
    const environment = authEnvironment();
    environment.userSettings.social = {
      google: {
        enabled: true,
        name: "Google",
        strategy: "oauth_google",
        authenticatable: true,
        logoUrl: "",
      },
    };
    const harness = setupAuth({ signedIn: false, environment, user: authUser() });
    const signIn = makeSignIn(harness.instance);
    renderSignIn(harness);
    expect((await screen.findByTestId("social-button-google")).textContent).toContain("Continue with Google");
    fireEvent.click(screen.getByTestId("social-button-google"));
    await waitFor(() => expect(signIn.authenticateWithRedirect).toHaveBeenCalled());
  });

  describe("when the instance has no email identifier to ask for", () => {
    const socialOnlyEnvironment = () => {
      const environment = authEnvironment();
      const { emailAddress, password, ...rest } = environment.userSettings.attributes;
      environment.userSettings.attributes = {
        ...rest,
        emailAddress: { ...emailAddress, enabled: false, required: false, usedForFirstFactor: false },
        password: { ...password, enabled: false, required: false, usedForFirstFactor: false },
      };
      environment.userSettings.social = {
        google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logoUrl: "" },
      };
      return environment;
    };

    it("shows the provider and no email field, no other-method link, and no password reset", async () => {
      const harness = setupAuth({ signedIn: false, environment: socialOnlyEnvironment() });
      makeSignIn(harness.instance);
      renderSignIn(harness);

      expect(await screen.findByTestId("social-button-google")).toBeTruthy();
      expect(screen.queryByLabelText(/Email address/)).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button", { name: /another method/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /forgot/i })).toBeNull();
    });

    it("does not offer password reset when passwords are off but email sign-in is on", async () => {
      const environment = authEnvironment();
      environment.userSettings.attributes.password = {
        ...environment.userSettings.attributes.password!,
        enabled: false,
        required: false,
        usedForFirstFactor: false,
      };
      const harness = setupAuth({ signedIn: false, environment });
      makeSignIn(harness.instance);
      renderSignIn(harness);

      expect(await screen.findByLabelText(/Email address/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /forgot/i })).toBeNull();
    });
  });
});
