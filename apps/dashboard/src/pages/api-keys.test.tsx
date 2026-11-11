import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ApiKeyJSON, UserJSON } from "@orbitid/shared";
import ApiKeysPage from "./api-keys";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const KEY = {
  id: "ak_1",
  name: "Reporting",
  subject: "user_1",
  prefix: "ak_live_abc",
  scopes: ["read:users"],
  revoked: false,
  expiration: null,
  last_used_at: null,
  created_at: 1_700_000_000_000,
} as unknown as ApiKeyJSON;

const USER = {
  id: "user_1",
  first_name: "Ada",
  last_name: "Lovelace",
  email_addresses: [{ email_address: "ada@example.com" }],
  username: "ada",
} as unknown as UserJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

const keysOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ ...KEY, id: `ak_${index}`, name: `Key ${index}` }));

describe("API keys page", () => {
  it("shows the loading skeleton", () => {
    pendingApi();
    renderPage(<ApiKeysPage />);
    expect(screen.getByLabelText("Loading rows")).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi();
    renderPage(<ApiKeysPage />);
    expect(await screen.findByText("No API keys")).toBeTruthy();
  });

  it("counts every page of keys and paginates client-side", async () => {
    mockApi({
      handle: (call) => {
        if (!call.url.includes("/v1/api_keys")) return undefined;
        const offset = Number(new URL(call.url).searchParams.get("offset") ?? 0);
        if (offset === 0) return list(keysOf(20), 25);
        return list(keysOf(5).map((key, index) => ({ ...key, id: `p2_${index}`, name: `Page two ${index}` })), 25);
      },
    });
    renderPage(<ApiKeysPage />);

    expect(await screen.findByText("Key 0")).toBeTruthy();
    expect(screen.getByText("25 active")).toBeTruthy();
    expect(screen.getByText("Showing 1–20 of 25")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Page two 0")).toBeTruthy();
  });

  it("shows a list error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/api_keys") ? json({ errors: [{ long_message: "Keys unavailable" }] }, 500) : undefined,
    });
    renderPage(<ApiKeysPage />);
    expect(await screen.findByText(/Keys unavailable/)).toBeTruthy();
  });

  it("does not list missing fields until the create form is submitted", async () => {
    mockApi({ handle: (call) => (call.url.includes("/v1/api_keys") ? list([]) : undefined) });
    renderPage(<ApiKeysPage />);
    await screen.findByText("No API keys");

    fireEvent.click(screen.getAllByRole("button", { name: /Create API key/ })[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText("Fix these before creating the key")).toBeNull();
    expect(within(sheet).queryByText("Choose a user or organization subject.")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Create key" }));
    expect(await within(sheet).findByText("Fix these before creating the key")).toBeTruthy();
    expect(within(sheet).getByText("Choose a user or organization subject.")).toBeTruthy();
  });

  it("creates a key for a searched user and reveals the secret once", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.url.includes("/v1/users?")) return list([USER], 1);
        if (call.method === "POST" && call.url.endsWith("/v1/api_keys")) return json({ secret: "ak_live_secret" });
        if (call.url.includes("/v1/api_keys")) return list([]);
        return undefined;
      },
    });
    renderPage(<ApiKeysPage />);
    await screen.findByText("No API keys");

    fireEvent.click(screen.getAllByRole("button", { name: /Create API key/ })[0]!);
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText(/Search users/), { target: { value: "ada" } });
    fireEvent.click(await screen.findByRole("button", { name: /Ada Lovelace/ }));
    fireEvent.change(within(sheet).getByLabelText(/Name/), { target: { value: "Production" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create key" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/api_keys"))?.body).toMatchObject({
        subject: "user_1",
        name: "Production",
        scopes: ["read:users"],
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Reveal secret" }));
    expect(await screen.findByText("ak_live_secret")).toBeTruthy();
  });

  it("revokes a key with an optional reason after confirmation", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/api_keys/ak_1/revoke")) return json({ ...KEY, revoked: true });
        if (call.url.includes("/v1/api_keys")) return list([KEY]);
        return undefined;
      },
    });
    renderPage(<ApiKeysPage />);
    await screen.findByText("Reporting");

    fireEvent.click(screen.getByTitle("Revoke"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: "Rotated" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/api_keys/ak_1/revoke"))?.body).toEqual({
        revocation_reason: "Rotated",
      });
    });
  });

  it("verifies a secret through the API", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/api_keys/verify")) return json({ valid: true });
        if (call.url.includes("/v1/api_keys")) return list([KEY]);
        return undefined;
      },
    });
    renderPage(<ApiKeysPage />);
    await screen.findByText("Reporting");

    fireEvent.change(screen.getByLabelText("Secret to verify"), { target: { value: "ak_live_abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify key" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/api_keys/verify"))?.body).toEqual({
        secret: "ak_live_abc",
      });
    });
    expect(await screen.findByText(/"valid": true/)).toBeTruthy();
  });
});
