import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import Page from "./settings-social";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

describe("social connections", () => {
  it("offers team ID, key ID and a .p8 key for Apple instead of a client secret", async () => {
    mockApi();
    renderPage(<Page />);

    const configureButtons = await screen.findAllByRole("button", { name: "Configure" });
    // Apple is the sixth built-in provider.
    fireEvent.click(configureButtons[5]!);

    expect(await screen.findByLabelText(/Team ID/)).toBeTruthy();
    expect(screen.getByLabelText(/Key ID/)).toBeTruthy();
    expect(screen.getByLabelText(/Private key \(\.p8\)/)).toBeTruthy();
    expect(screen.getByText("Client secret (optional)")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Apple/ })).toBeTruthy();
    expect(screen.getByText(/BEGIN PRIVATE KEY/)).toBeTruthy();
  });

  it("keeps a stored Apple key and accepts the rest of the credentials", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.social.apple = {
          enabled: true,
          clientId: "com.example.web",
          clientSecret: "",
          scopes: ["name", "email"],
          authenticatableAtSignIn: true,
          appleTeamId: "TEAM123456",
          appleKeyId: "KEY7890123",
          applePrivateKey: "••••",
        };
      }),
    });
    renderPage(<Page />);

    const configureButtons = await screen.findAllByRole("button", { name: "Configure" });
    fireEvent.click(configureButtons[5]!);
    const key = (await screen.findByLabelText(/Private key \(\.p8\)/)) as HTMLTextAreaElement;
    expect(key.value).toBe("");
    expect(screen.getAllByText("Set").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/Key ID/), { target: { value: "KEY0000000" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const body = calls.find((call) => call.method === "PATCH")?.body as
        | { social?: { apple?: Record<string, unknown> } }
        | undefined;
      expect(body?.social?.apple?.appleKeyId).toBe("KEY0000000");
      // The masked key is never written back.
      expect(body?.social?.apple?.applePrivateKey).toBeUndefined();
    });
  });

  it("treats a stored client secret as configured and never resends the mask", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.social.google = {
          enabled: true,
          clientId: "google-id",
          clientSecret: "••••",
          scopes: ["openid", "email"],
          authenticatableAtSignIn: true,
        };
      }),
    });
    renderPage(<Page />);

    const configureButtons = await screen.findAllByRole("button", { name: "Configure" });
    fireEvent.click(configureButtons[0]!);
    const secret = (await screen.findByLabelText(/Client secret/)) as HTMLInputElement;
    expect(secret.value).toBe("");

    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: "google-id-2" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const body = calls.find((call) => call.method === "PATCH")?.body as
        | { social?: { google?: Record<string, unknown> } }
        | undefined;
      expect(body?.social?.google?.clientId).toBe("google-id-2");
      expect(body?.social?.google?.clientSecret).toBeUndefined();
    });
  });
});
