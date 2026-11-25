import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import Page from "./oauth-apps";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";
import { billingPortalUrlError } from "../lib/billing";

const APPLICATION = {
  object: "oauth_application" as const,
  id: "oa_1",
  name: "Acme Dashboard",
  client_id: "oa_client",
  public: false,
  redirect_uris: ["https://app.example.com/oauth/callback"],
  post_logout_redirect_uris: [],
  scopes: "openid profile email",
  consent_screen_enabled: true,
  pkce_required: true,
  access_token_lifetime_seconds: 3600,
  refresh_token_lifetime_seconds: 2_592_000,
  id_token_lifetime_seconds: 3600,
  groups_claim: "all" as const,
  organization_id: null as string | null,
  billing_portal_url: "https://pay.example.com/acme" as string | null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

function mock(application = APPLICATION) {
  return mockApi({
    instance: instanceBody(),
    handle: (call) => {
      if (call.url.includes("/v1/oauth_applications")) {
        return new Response(JSON.stringify({ data: [application], total_count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (call.url.includes("/v1/organizations")) {
        return new Response(JSON.stringify({ data: [], total_count: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    },
  });
}

async function openEdit() {
  fireEvent.click((await screen.findAllByTitle("Edit"))[0]!);
  const sheet = await screen.findByRole("dialog");
  return { sheet, input: within(sheet).getByLabelText("Billing portal URL") as HTMLInputElement };
}

describe("OAuth application billing portal", () => {
  it("shows the stored portal, sends a changed one and clears it with null", async () => {
    const calls = mock();
    renderPage(<Page />);
    const { sheet, input } = await openEdit();
    expect(input.value).toBe("https://pay.example.com/acme");

    fireEvent.change(input, { target: { value: "  https://pay.example.com/v2  " } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
        billing_portal_url: "https://pay.example.com/v2",
      });
    });
  });

  it("clears the portal with null", async () => {
    const calls = mock();
    renderPage(<Page />);
    const { sheet, input } = await openEdit();
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Save changes/ }));
    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ billing_portal_url: null });
    });
  });

  it("refuses a portal that is not https before sending anything", async () => {
    const calls = mock();
    renderPage(<Page />);
    const { sheet, input } = await openEdit();
    fireEvent.change(input, { target: { value: "http://pay.example.com" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Save changes/ }));
    expect(await within(sheet).findByText("The billing portal URL must start with https://.")).toBeTruthy();
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("creates an application without a portal field unless one is set", async () => {
    const calls = mock({ ...APPLICATION, billing_portal_url: null });
    renderPage(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: /Create application/ }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText(/Application name/), { target: { value: "New app" } });
    fireEvent.change(within(sheet).getByPlaceholderText("https://app.example.com/oauth/callback"), {
      target: { value: "https://new.example.com/cb" },
    });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create application" }));
    await waitFor(() => {
      const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/oauth_applications"));
      expect(created?.body?.name).toBe("New app");
      expect(created?.body).not.toHaveProperty("billing_portal_url");
    });
  });
});

describe("billingPortalUrlError", () => {
  it("accepts empty and https URLs and explains everything else", () => {
    expect(billingPortalUrlError("")).toBeNull();
    expect(billingPortalUrlError("  ")).toBeNull();
    expect(billingPortalUrlError("https://pay.example.com/portal")).toBeNull();
    expect(billingPortalUrlError("http://pay.example.com")).toMatch(/https/);
    expect(billingPortalUrlError("javascript:alert(1)")).toMatch(/https/);
    expect(billingPortalUrlError("https://user:pw@pay.example.com")).toMatch(/username or password/);
    expect(billingPortalUrlError("pay.example.com")).toMatch(/absolute https URL/);
  });
});
