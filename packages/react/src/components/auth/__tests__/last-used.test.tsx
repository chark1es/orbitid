import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { SignIn } from "../index";
import { authEnvironment, makeSignIn, renderAuth, setupAuth } from "./fake-auth";

function renderSignIn(lastUsedStrategy: string | null) {
  const harness = setupAuth({ signedIn: false, environment: authEnvironment() });
  harness.instance.lastUsedStrategy = lastUsedStrategy;
  makeSignIn(harness.instance);
  renderAuth(<SignIn routing="virtual" />, harness);
  return harness;
}

describe("last used sign-in method", () => {
  it.each(["password", "email_code"])("labels the identifier field after a %s sign-in", async (strategy) => {
    renderSignIn(strategy);
    const badge = await screen.findByTestId("identifier-last-used");
    expect(badge.textContent).toBe("Last used");
  });

  it("shows no badge when nothing was used before", async () => {
    renderSignIn(null);
    await screen.findByLabelText(/email/i);
    expect(screen.queryByText("Last used")).toBeNull();
  });

  it("leaves the identifier field alone after a social sign-in", async () => {
    renderSignIn("oauth_google");
    await screen.findByLabelText(/email/i);
    expect(screen.queryByTestId("identifier-last-used")).toBeNull();
  });

  it("labels the remembered method on the other-methods screen", async () => {
    renderSignIn("password");
    fireEvent.click(await screen.findByRole("button", { name: /use another method/i }));
    const option = await screen.findByTestId("strategy-password");
    expect(within(option).getByText("Last used")).toBeTruthy();
    expect(screen.getByTestId("strategy-email_code").textContent).not.toContain("Last used");
  });
});
