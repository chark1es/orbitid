import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import Page from "./enterprise-sso";
import { mockApi, renderPage } from "./_config/__tests__/harness";

const CONNECTION = {
  object: "enterprise_connection" as const,
  id: "ent_1",
  name: "Acme identity",
  protocol: "oidc" as const,
  provider: "custom",
  domains: ["acme.test"],
  active: true,
  allow_subdomains: false,
  allow_idp_initiated: false,
  sync_user_attributes: true,
  disable_additional_identifications: false,
  oidc: {
    client_id: "acme-client",
    discovery_url: "https://idp.acme.test/.well-known/openid-configuration",
  },
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

describe("enterprise SSO", () => {
  it("offers a write-only secret replacement and never renders a stored one", async () => {
    const calls = mockApi({
      handle: (call) =>
        call.url.includes("/v1/enterprise_connections")
          ? new Response(JSON.stringify({ data: [CONNECTION], total_count: 1 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : undefined,
    });
    renderPage(<Page />);

    fireEvent.click(await screen.findByTitle("Details"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("acme-client");
    expect(dialog.textContent).toContain("never returned by the API");

    const field = screen.getByLabelText(/Replace client secret/) as HTMLInputElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "new-oidc-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace secret" }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH" && call.url.includes("/enterprise_connections/ent_1"));
      expect(patch?.body).toEqual({ client_secret: "new-oidc-secret" });
    });
    // The typed value is cleared so it is not accidentally resent with another change.
    await waitFor(() => expect((screen.getByLabelText(/Replace client secret/) as HTMLInputElement).value).toBe(""));
  });
});
