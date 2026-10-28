import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SignIn } from "../index";
import { authEnvironment, authUser, enterOtp, makeSignIn, renderAuth, setupAuth, SESSION_ID } from "./fake-auth";

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

  it("verifies a TOTP second factor", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_second_factor",
        identifier: "ada@example.com",
        supportedSecondFactors: [{ strategy: "totp" }],
      },
      attemptSecondFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Verify your identity")).toBeTruthy();
    act(() => enterOtp("654321"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(signIn.attemptSecondFactor).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "totp", code: "654321" }),
    ));
    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
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
});
