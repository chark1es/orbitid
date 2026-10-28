import { beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ApiKeyJSON } from "@orbitid/shared";
import { resetVirtualRouter } from "../../../lib/routing";
import { APIKeys } from "../APIKeys";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

const apiKey = (overrides: Partial<ApiKeyJSON> = {}): ApiKeyJSON => ({
  object: "api_key",
  id: "key_1",
  name: "Deploy",
  description: "CI key",
  subject: "user",
  prefix: "ak_live_1",
  scopes: [],
  claims: null,
  revoked: false,
  expiration: null,
  last_used_at: null,
  created_by: null,
  created_at: Date.now(),
  updated_at: Date.now(),
  ...overrides,
});

describe("<APIKeys />", () => {
  test("lists organization API keys", async () => {
    const fake = createFakeInstance();
    fake.backend.apiKeys = [apiKey()];
    renderWithOrbit(<APIKeys type="organization" showDescription />, fake);

    expect(await screen.findByText("Deploy")).toBeTruthy();
    expect(screen.getByText("CI key")).toBeTruthy();
    expect(screen.getByText("ak_live_1")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
  });

  test("creates a key, reveals the secret once and copies it", async () => {
    const fake = createFakeInstance();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithOrbit(<APIKeys type="organization" showDescription />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Create API key" }));
    const createDialog = await screen.findByRole("dialog");
    fireEvent.change(within(createDialog).getByLabelText("Name"), {
      target: { value: "CI deploy" },
    });
    fireEvent.change(within(createDialog).getByLabelText("Description"), {
      target: { value: "Deploy pipeline" },
    });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create" }));

    const revealDialog = await screen.findByRole("dialog", { name: "Copy your API key" });
    const secret = within(revealDialog).getByTestId("api-key-secret").textContent ?? "";
    expect(secret).toContain("ak_live_secret");

    fireEvent.click(within(revealDialog).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(secret));
    expect(await within(revealDialog).findByRole("button", { name: "Copied" })).toBeTruthy();

    fireEvent.click(within(revealDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("api-key-secret")).toBeNull());
    expect(await screen.findByText("CI deploy")).toBeTruthy();

    expect(fake.backend.apiKeys[0]).toMatchObject({
      name: "CI deploy",
      description: "Deploy pipeline",
      expiration: null,
    });
  });

  test("applies a preset expiration to the created key", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<APIKeys type="organization" />, fake);

    fireEvent.click(await screen.findByRole("button", { name: "Create API key" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Short lived" },
    });

    fireEvent.click(within(dialog).getByRole("combobox", { name: "Expiration" }));
    fireEvent.click(await screen.findByRole("option", { name: "30 days" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await screen.findByRole("dialog");
    const expiration = fake.backend.apiKeys[0]?.expiration ?? null;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(expiration).not.toBeNull();
    expect(Math.abs((expiration ?? 0) - (Date.now() + thirtyDays))).toBeLessThan(60_000);
    expect(fake.backend.apiKeys[0]?.name).toBe("Short lived");
  });

  test("revokes a key after confirmation", async () => {
    const fake = createFakeInstance();
    fake.backend.apiKeys = [apiKey()];
    renderWithOrbit(<APIKeys type="organization" />, fake);

    await screen.findByText("Deploy");
    fireEvent.click(screen.getByRole("button", { name: "Revoke Deploy" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => expect(fake.backend.apiKeys[0]?.revoked).toBe(true));
    expect(await screen.findByText("Revoked")).toBeTruthy();
  });

  test("falls back to the Frontend API for user-scoped keys when the SDK lacks them", async () => {
    const fake = createFakeInstance();
    fake.backend.apiKeys = [apiKey({ id: "key_user", name: "CLI" })];
    delete fake.instance.apiKeys;
    renderWithOrbit(<APIKeys type="user" />, fake);

    expect(await screen.findByText("CLI")).toBeTruthy();
    expect(
      fake.backend.calls.fetch.some((call) => call.method === "GET" && call.path === "/me/api_keys"),
    ).toBe(true);
  });

  test("prompts for an organization when none is active", async () => {
    const fake = createFakeInstance({ activeOrgId: null });
    renderWithOrbit(<APIKeys type="organization" />, fake);

    expect(await screen.findByText(/Select an organization/i)).toBeTruthy();
  });
});
