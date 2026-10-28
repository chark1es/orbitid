import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { UserProfile } from "../index";
import type { UserResource } from "../../../provider/types";
import { enterOtp, renderAuth, setupAuth } from "./fake-auth";

async function goToSecurity() {
  fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]!);
  expect(await screen.findByText("Passkeys")).toBeTruthy();
}

describe("UserProfile", () => {
  it("adds and verifies an email address", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    const createdEmail = {
      id: "idn_e2",
      emailAddress: "grace@example.com",
      verification: { status: "unverified", strategy: "email_code", attempts: 0, expireAt: null },
      prepareVerification: vi.fn(async function (this: unknown) {
        return this;
      }),
      attemptVerification: vi.fn(async function (this: unknown) {
        Object.assign(this as object, {
          verification: { status: "verified", strategy: "email_code", attempts: 1, expireAt: null },
        });
        const list = (user.emailAddresses ?? []).map((email) =>
          email.id === createdEmail.id ? { ...email, verification: (this as { verification: unknown }).verification } : email,
        );
        user.emailAddresses = list as never;
        harness.instance.emit();
        return this;
      }),
      destroy: vi.fn(async () => undefined),
    };
    user.createEmailAddress = vi.fn(async () => {
      user.emailAddresses = [...(user.emailAddresses ?? []), createdEmail as never];
      harness.instance.emit();
      return createdEmail as never;
    });

    renderAuth(<UserProfile routing="virtual" />, harness);

    fireEvent.click(await screen.findByRole("button", { name: "Add email address" }));
    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: "grace@example.com" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));

    await waitFor(() => expect(user.createEmailAddress).toHaveBeenCalledWith({ email: "grace@example.com" }));
    await waitFor(() => expect(document.querySelector("input[data-input-otp]")).toBeTruthy());
    enterOtp("987654");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(createdEmail.attemptVerification).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("grace@example.com")).toBeTruthy();
  });

  it("changes the password with sign-out-of-other-devices", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();

    fireEvent.change(screen.getByLabelText(/Current password/), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: "New-Password!23" } });
    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: "New-Password!23" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(user.updatePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        currentPassword: "old-password",
        newPassword: "New-Password!23",
        signOutOfOtherSessions: true,
      }),
    ));
    expect(await screen.findByText("Password updated.")).toBeTruthy();
  });

  it("sets up TOTP with the server-provided QR code", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();

    fireEvent.click(screen.getByRole("button", { name: "Add authenticator app" }));
    const qr = await screen.findByTestId("totp-qr");
    expect(qr.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeTruthy();

    enterOtp("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify and enable" }));
    await waitFor(() => expect(user.verifyTOTP).toHaveBeenCalledWith({ code: "123456" }));
  });

  it("requires typing the confirmation phrase before deleting the account", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete my account" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Type "Delete account"/), { target: { value: "Delete" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(within(dialog).getByLabelText(/Type "Delete account"/), { target: { value: "Delete account" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(user.delete).toHaveBeenCalled());
    expect(harness.instance.navigations.at(-1)?.to).toBe("/");
  });

  it("renders custom pages and links in the navigation", async () => {
    const harness = setupAuth();
    renderAuth(
      <UserProfile routing="virtual">
        <UserProfile.Page label="Billing" url="billing">
          <p>Billing settings</p>
        </UserProfile.Page>
        <UserProfile.Link label="Help" url="https://example.com/help" />
      </UserProfile>,
      harness,
    );
    expect(await screen.findByText("Billing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Billing" }));
    expect(await screen.findByText("Billing settings")).toBeTruthy();
    expect(screen.getByText("Help").closest("a")?.getAttribute("href")).toBe("https://example.com/help");
  });
});
