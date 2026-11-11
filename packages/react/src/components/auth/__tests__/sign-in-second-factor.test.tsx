import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { SignIn } from "../index";
import { authEnvironment, enterOtp, makeSignIn, renderAuth, setupAuth, SESSION_ID } from "./fake-auth";

function renderSignIn(
  harness: ReturnType<typeof setupAuth>,
  props: Partial<Parameters<typeof SignIn>[0]> = {},
) {
  return renderAuth(<SignIn routing="virtual" {...props} />, harness);
}

describe("SignIn second factor", () => {
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

  it("keeps the factor-two step when the router remounts before the URL catches up", async () => {
    // The Next.js App Router remounts the catch-all auth page before it updates window.location: the new
    // mount still sees the URL of the step it just left (/sign-in/factor-one). That stale slug must not
    // pull the flow back to the password form when the sign-in resource says needs_second_factor.
    window.history.pushState({}, "", "/sign-in/factor-one");
    try {
      const harness = setupAuth({ signedIn: false });
      const signIn = makeSignIn(harness.instance, {
        attemptFirstFactor: { status: "needs_second_factor", supportedSecondFactors: [{ strategy: "totp" }] },
        attemptSecondFactor: { status: "complete", createdSessionId: SESSION_ID },
      });
      Object.assign(signIn, {
        status: "needs_first_factor",
        identifier: "ada@example.com",
        supportedFirstFactors: [{ strategy: "password" }],
      });

      const view = renderAuth(<SignIn routing="path" path="/sign-in" />, harness);
      fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: "correct horse" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() => expect(harness.instance.navigations.at(-1)?.to).toBe("/sign-in/factor-two"));

      view.unmount();
      renderAuth(<SignIn routing="path" path="/sign-in" />, harness);

      expect(await screen.findByText("Verify your identity")).toBeTruthy();
      expect(screen.queryByLabelText(/^Password/)).toBeNull();
      expect(document.querySelector("input[data-input-otp]")).toBeTruthy();

      act(() => enterOtp("654321"));
      fireEvent.click(screen.getByRole("button", { name: "Verify" }));
      await waitFor(() =>
        expect(signIn.attemptSecondFactor).toHaveBeenCalledWith(
          expect.objectContaining({ strategy: "totp", code: "654321" }),
        ),
      );
      await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("submits a backup code picked from the second-factor method list", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
        identifier: "ada@example.com",
      },
      attemptFirstFactor: {
        status: "needs_second_factor",
        supportedSecondFactors: [{ strategy: "totp" }, { strategy: "backup_code" }],
      },
      attemptSecondFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Verify your identity")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "Use another method" }));
    fireEvent.click(await screen.findByRole("option", { name: "Backup code" }));
    // A backup code is not a six-digit OTP: it needs a plain text field.
    expect(document.querySelector("input[data-input-otp]")).toBeNull();
    fireEvent.change(screen.getByLabelText("Verification code"), { target: { value: "ABCD1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() =>
      expect(signIn.attemptSecondFactor).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: "backup_code", code: "ABCD1234" }),
      ),
    );
    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
  });

  it("prepares and submits a text-message second factor", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_first_factor",
        supportedFirstFactors: [{ strategy: "password" }],
        identifier: "ada@example.com",
      },
      attemptFirstFactor: {
        status: "needs_second_factor",
        supportedSecondFactors: [{ strategy: "totp" }, { strategy: "phone_code", phone_number_id: "idn_p1" }],
      },
      prepareSecondFactor: { status: "needs_second_factor" },
      attemptSecondFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.change(await screen.findByLabelText(/^Password/), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Verify your identity")).toBeTruthy();

    fireEvent.click(screen.getByRole("combobox", { name: "Use another method" }));
    fireEvent.click(await screen.findByRole("option", { name: "Text message code" }));
    await waitFor(() =>
      expect(signIn.prepareSecondFactor).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: "phone_code", phoneNumberId: "idn_p1" }),
      ),
    );
    act(() => enterOtp("112233"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() =>
      expect(signIn.attemptSecondFactor).toHaveBeenCalledWith(
        expect.objectContaining({ strategy: "phone_code", code: "112233" }),
      ),
    );
  });

  it("offers email as a second factor and prepares the code", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_second_factor",
        identifier: "ada@example.com",
        supportedSecondFactors: [{ strategy: "totp" }, { strategy: "email_code", emailAddressId: "idn_e1" }],
      },
      prepareSecondFactor: { status: "needs_second_factor" },
      attemptSecondFactor: { status: "complete", createdSessionId: SESSION_ID },
    });
    renderSignIn(harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Verify your identity")).toBeTruthy();
    // The method picker lists the email option next to the authenticator app.
    fireEvent.click(screen.getByRole("combobox", { name: "Use another method" }));
    fireEvent.click(await screen.findByRole("option", { name: "Email code" }));

    await waitFor(() => expect(signIn.prepareSecondFactor).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "email_code", emailAddressId: "idn_e1" }),
    ));
    // The email method is selected: the code goes out to the account's address.
    expect(screen.getByRole("combobox", { name: "Use another method" }).textContent).toContain("Email code");
    act(() => enterOtp("112233"));
    await waitFor(() => expect(signIn.attemptSecondFactor).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "email_code", code: "112233" }),
    ));
  });

  it("shows the trust-this-browser checkbox only when the environment enables it", async () => {
    const environment = authEnvironment();
    environment.authConfig.trustedDevices = { enabled: true, days: 7 };
    const harness = setupAuth({ signedIn: false, environment });
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

    const checkbox = await screen.findByLabelText("Trust this browser for 7 days");
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    act(() => enterOtp("654321"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(signIn.attemptSecondFactor).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "totp", code: "654321", trustDevice: true }),
    ));
  });

  it("hides the trust checkbox when trusted devices are disabled", async () => {
    const harness = setupAuth({ signedIn: false });
    makeSignIn(harness.instance, {
      create: {
        status: "needs_second_factor",
        identifier: "ada@example.com",
        supportedSecondFactors: [{ strategy: "totp" }],
      },
    });
    renderSignIn(harness);

    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Verify your identity")).toBeTruthy();
    expect(screen.queryByLabelText(/Trust this browser/)).toBeNull();
  });
});
