import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { SignIn } from "../index";
import { authEnvironment, enterOtp, makeSignIn, renderAuth, setupAuth } from "./fake-auth";

function renderSignIn(harness: ReturnType<typeof setupAuth>) {
  return renderAuth(<SignIn routing="virtual" />, harness);
}

describe("SignIn recovery and social providers", () => {
  it("returns to the password step with a notice when a reset cannot create a session", async () => {
    const harness = setupAuth({ signedIn: false });
    const signIn = makeSignIn(harness.instance, {
      create: {
        status: "needs_first_factor",
        identifier: "ada@example.com",
        supportedFirstFactors: [{ strategy: "reset_password_email_code", emailAddressId: "idn_e1" }],
      },
      prepareFirstFactor: { status: "needs_first_factor" },
      attemptFirstFactor: (params) =>
        params.strategy === "reset_password_email_code"
          ? { status: "needs_new_password" }
          : {
              status: "needs_second_factor",
              supported_second_factors: [{ strategy: "totp" }],
              first_factor_verification: { status: "verified", strategy: "password" },
            },
      resetPassword: {
        status: "needs_first_factor",
        supported_first_factors: [{ strategy: "password" }],
        first_factor_verification: {
          status: "unverified",
          strategy: "password",
          error: {
            code: "needs_second_factor",
            message: "MFA is required. Sign in with your new password to complete a second factor.",
          },
        },
      },
    });
    renderSignIn(harness);

    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));

    await waitFor(() => expect(document.querySelector("input[data-input-otp]")).toBeTruthy());
    act(() => enterOtp("111111"));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    fireEvent.change(await screen.findByLabelText(/New password/), { target: { value: "N3w-Password!23" } });
    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: "N3w-Password!23" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    // The reset form is replaced by the password step, which says why a fresh sign-in is needed.
    expect(await screen.findByLabelText(/^Password/)).toBeTruthy();
    expect(screen.queryByLabelText(/New password/)).toBeNull();
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("Your password was changed");
    expect(notice.textContent).toContain("new password");

    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "N3w-Password!23" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Verify your identity")).toBeTruthy();
    expect(signIn.attemptFirstFactor).toHaveBeenLastCalledWith({
      strategy: "password",
      password: "N3w-Password!23",
    });
  });

  it("marks the last-used provider in the icon-only variant", async () => {
    const environment = authEnvironment();
    environment.userSettings.social = {
      google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logoUrl: "" },
      github: { enabled: true, name: "GitHub", strategy: "oauth_github", authenticatable: true, logoUrl: "" },
      gitlab: { enabled: true, name: "GitLab", strategy: "oauth_gitlab", authenticatable: true, logoUrl: "" },
      bitbucket: { enabled: true, name: "Bitbucket", strategy: "oauth_bitbucket", authenticatable: true, logoUrl: "" },
    };
    const harness = setupAuth({ signedIn: false, environment });
    harness.instance.lastUsedStrategy = "oauth_github";
    makeSignIn(harness.instance);
    renderSignIn(harness);

    const github = await screen.findByTestId("social-button-github");
    // No room for a text badge on an icon button: a dot plus an accessible name keeps the feature.
    expect(github.getAttribute("aria-label")).toBe("GitHub, Last used");
    expect(within(github).getByTestId("social-last-used-github")).toBeTruthy();
    const google = screen.getByTestId("social-button-google");
    expect(google.getAttribute("aria-label")).toBe("Google");
    expect(within(google).queryByTestId("social-last-used-google")).toBeNull();
  });
});
