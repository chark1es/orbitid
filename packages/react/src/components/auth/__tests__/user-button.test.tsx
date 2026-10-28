import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { UserButton } from "../index";
import { authEnvironment, renderAuth, setupAuth, SESSION_ID } from "./fake-auth";

async function openMenu() {
  const trigger = screen.getByRole("button", { name: "Account" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  return trigger;
}

describe("UserButton", () => {
  it("shows the account summary and signs out", async () => {
    const harness = setupAuth();
    renderAuth(<UserButton showName afterSignOutUrl="/signed-out" />, harness);

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    await openMenu();

    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("Manage account")).toBeTruthy();
    fireEvent.click(screen.getByTestId("user-button-sign-out"));

    await waitFor(() => expect(harness.instance.signOutCalls.length).toBe(1));
    expect(harness.instance.signOutCalls[0]?.sessionId).toBe(SESSION_ID);
    expect(harness.instance.navigations.at(-1)?.to).toBe("/signed-out");
  });

  it("navigates to the profile in navigation mode", async () => {
    const harness = setupAuth();
    renderAuth(<UserButton userProfileMode="navigation" userProfileUrl="/account" />, harness);
    await openMenu();
    fireEvent.click(await screen.findByText("Manage account"));
    expect(harness.instance.navigations.at(-1)?.to).toBe("/account");
  });

  it("renders custom menu items", async () => {
    const harness = setupAuth();
    const onClick = () => undefined;
    renderAuth(
      <UserButton afterSignOutUrl="/">
        <UserButton.MenuItems>
          <UserButton.Action label="Billing" onClick={onClick} />
          <UserButton.Link label="Docs" href="https://example.com/docs" />
        </UserButton.MenuItems>
      </UserButton>,
      harness,
    );
    await openMenu();
    expect(await screen.findByText("Billing")).toBeTruthy();
    expect(screen.getByText("Docs").closest("a")?.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("lists sessions and switches accounts", async () => {
    const environment = authEnvironment();
    environment.authConfig.singleSessionMode = false;
    const harness = setupAuth({ environment });
    const second = {
      id: "sess_2",
      status: "active",
      publicUserData: { user_id: "user_2", identifier: "grace@example.com", first_name: "Grace" },
      getToken: async () => "token",
    };
    harness.instance.client = {
      ...harness.instance.client!,
      sessions: [...harness.instance.client!.sessions, second as never],
    };
    harness.instance.emit();
    renderAuth(<UserButton afterSwitchSessionUrl="/switched" />, harness);
    await openMenu();

    const sessionItem = await screen.findByTestId("session-sess_2");
    fireEvent.click(sessionItem);
    await waitFor(() => expect(harness.instance.setActiveCalls.length).toBe(1));
    const switched = harness.instance.setActiveCalls[0]?.session;
    expect(typeof switched === "string" ? switched : switched?.id).toBe("sess_2");
    expect(harness.instance.navigations.at(-1)?.to).toBe("/switched");
  });
});
