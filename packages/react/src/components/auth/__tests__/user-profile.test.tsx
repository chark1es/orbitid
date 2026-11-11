import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { UserProfile } from "../index";
import type { UserResource } from "../../../provider/types";
import { authEnvironment, enterOtp, renderAuth, setupAuth } from "./fake-auth";

async function goToSecurity() {
  fireEvent.click(screen.getAllByRole("button", { name: "Security" })[0]!);
  expect(await screen.findByText("Passkeys")).toBeTruthy();
}

describe("UserProfile", () => {
  it("keeps the account tab strip inside its container on a phone", () => {
    const harness = setupAuth();
    renderAuth(<UserProfile routing="virtual" />, harness);
    const nav = screen.getByRole("navigation", { name: /Account/ });
    // A negative margin made the strip wider than its parent (281px in a 277px box).
    expect(nav.className).not.toContain("-mx-1");
    expect(nav.className).toContain("overflow-x-auto");
    // The strip still scrolls, but without a native scrollbar or its stray thumb at 375px.
    expect(nav.className).toContain("[scrollbar-width:none]");
    expect(nav.className).toContain("[&::-webkit-scrollbar]:hidden");
  });

  it("offers Security once, in the navigation, not as a stray link at the card footer", async () => {
    const harness = setupAuth();
    renderAuth(<UserProfile routing="virtual" />, harness);
    const nav = screen.getByRole("navigation", { name: /Account/ });
    const security = within(nav).getByRole("button", { name: "Security" });
    expect(security).toBeTruthy();
    // The profile page used to add a centred "Security" link after its last section, next to the app name.
    const buttons = screen.getAllByRole("button", { name: "Security" });
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toBe(security);
    expect(security.className).not.toContain("mx-auto");
  });

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

  it("keeps other devices signed in unless the user opts in", async () => {
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
        signOutOfOtherSessions: false,
      }),
    ));
    expect(await screen.findByText("Password updated.")).toBeTruthy();
  });

  it("signs out other devices when the user turns the switch on", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();

    fireEvent.click(screen.getByRole("switch", { name: /Sign out of all other devices/i }));
    fireEvent.change(screen.getByLabelText(/Current password/), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText(/New password/), { target: { value: "New-Password!23" } });
    fireEvent.change(screen.getByLabelText(/Confirm password/), { target: { value: "New-Password!23" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(user.updatePassword).toHaveBeenCalledWith(
      expect.objectContaining({ signOutOfOtherSessions: true }),
    ));
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

  it("lists trusted devices and revokes one", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    const environment = harness.instance.environment!;
    environment.authConfig.trustedDevices = { enabled: true, days: 30 };
    user.getTrustedDevices = vi.fn(async () => [
      { id: "tdev_1", label: "Trusted browser", expiresAt: Date.now() + 86400_000, lastUsedAt: null },
    ]) as never;
    user.revokeTrustedDevice = vi.fn(async () => undefined) as never;

    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();

    expect(await screen.findByText("Trusted devices")).toBeTruthy();
    expect(await screen.findByText("Trusted browser")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(user.revokeTrustedDevice).toHaveBeenCalledWith("tdev_1"));
  });

  it("hides the trusted devices section when the instance disables it", async () => {
    const harness = setupAuth();
    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();
    expect(screen.queryByText("Trusted devices")).toBeNull();
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

  it("clears the typed confirmation when the delete dialog is cancelled", async () => {
    const harness = setupAuth();
    const user = harness.instance.user as UserResource;
    renderAuth(<UserProfile routing="virtual" />, harness);
    await goToSecurity();

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Type "Delete account"/), { target: { value: "Delete account" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
    dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/Type "Delete account"/) as HTMLInputElement).value).toBe("");
    expect((within(dialog).getByRole("button", { name: "Delete my account" }) as HTMLButtonElement).disabled).toBe(true);
    expect(user.delete).not.toHaveBeenCalled();
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

  it("does not save a blank required name and says why", async () => {
    const environment = authEnvironment();
    environment.userSettings.attributes.firstName = {
      ...environment.userSettings.attributes.firstName!,
      required: true,
    };
    const harness = setupAuth({ environment });
    const user = harness.instance.user as UserResource;
    renderAuth(<UserProfile routing="virtual" />, harness);

    const firstName = await screen.findByLabelText(/First name/);
    fireEvent.change(firstName, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("This field is required.")).toBeTruthy();
    expect(user.update).not.toHaveBeenCalled();

    fireEvent.change(firstName, { target: { value: "Grace" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(user.update).toHaveBeenCalledWith(expect.objectContaining({ firstName: "Grace" })));
  });

  it("keeps the only phone number when the instance requires one", async () => {
    const environment = authEnvironment();
    environment.userSettings.attributes.phoneNumber = {
      enabled: true,
      required: true,
      usedForFirstFactor: false,
      usedForSecondFactor: false,
      verifications: ["phone_code"],
      verifyAtSignUp: false,
    };
    const harness = setupAuth({ environment });
    const user = harness.instance.user as UserResource;
    user.phoneNumbers = [
      {
        id: "idn_p1",
        phoneNumber: "+15551234567",
        verification: { status: "verified", strategy: "phone_code", attempts: 0, expireAt: null },
        destroy: vi.fn(async () => undefined),
      } as never,
    ];
    renderAuth(<UserProfile routing="virtual" />, harness);

    const remove = await screen.findByRole("button", { name: "Remove phone number" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
  });
});
