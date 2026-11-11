import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

describe("enterprise SSO column visibility", () => {
  it("hides protocol, domain and created columns until they fit at 1024 and 768", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/enterprise_connections")
          ? new Response(JSON.stringify({ data: [CONNECTION], total_count: 1 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : undefined,
    });
    renderPage(<Page />);
    await screen.findByText("Acme identity");

    const protocol = screen.getByRole("columnheader", { name: "Protocol" });
    expect(protocol.className).toContain("hidden");
    expect(protocol.className).toContain("xl:table-cell");
    const domains = screen.getByRole("columnheader", { name: "Domains" });
    expect(domains.className).toContain("hidden");
    expect(domains.className).toContain("lg:table-cell");
    const created = screen.getByRole("columnheader", { name: "Created" });
    expect(created.className).toContain("hidden");
    expect(created.className).toContain("xl:table-cell");
    expect(screen.getByRole("columnheader", { name: "Connection" })).toBeTruthy();
  });
});

describe("enterprise SSO wizard — SAML metadata", () => {
  it("does not greet a fresh wizard with a validation list", async () => {
    mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Connect SSO/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByText("Fix these to continue")).toBeNull();
    expect(within(dialog).queryByText(/is required/)).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    expect(await within(dialog).findByText("Fix these to continue")).toBeTruthy();
    expect(within(dialog).getByText(/Connection name is required/)).toBeTruthy();
  });

  it("keeps the validation message clear of the sticky footer and scrolls it into view", async () => {
    mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Connect SSO/ }));
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Connection name is required.")).toBeTruthy();
    expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    // The scroll body reserves the footer's height so the last field can always clear it.
    expect(screen.getByRole("dialog").querySelector(".pb-24")).toBeTruthy();
  });

  it("styles the metadata file picker like a 34px control", async () => {
    mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Connect SSO/ }));
    fireEvent.change(screen.getByLabelText(/Connection name/), { target: { value: "Acme SAML" } });
    fireEvent.change(screen.getByPlaceholderText("example.com"), { target: { value: "acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    const file = (await screen.findByLabelText(/Or upload metadata XML/)) as HTMLInputElement;
    expect(file.type).toBe("file");
    expect(file.className).toContain("h-[34px]");
    expect(file.className).toContain("file:h-[34px]");
  });

  it("creates a connection from a metadata URL without retyping entity id, URL and certificate", async () => {
    const calls = mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Connect SSO/ }));
    fireEvent.change(screen.getByLabelText(/Connection name/), { target: { value: "Acme SAML" } });
    fireEvent.change(screen.getByPlaceholderText("example.com"), { target: { value: "acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByLabelText(/Metadata URL/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Metadata URL/), { target: { value: "https://idp.acme.test/metadata" } });
    // The three manual fields are still present but no longer required.
    expect(screen.getByLabelText(/IdP entity ID/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.click(await screen.findByRole("button", { name: /Create connection/ }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST" && call.url.includes("/v1/enterprise_connections"));
      expect(post?.body).toMatchObject({
        name: "Acme SAML",
        protocol: "saml",
        domains: ["acme.test"],
        idp_metadata_url: "https://idp.acme.test/metadata",
      });
      expect(post?.body).not.toHaveProperty("idp_certificate");
    });
  });
});

describe("enterprise SSO protocol column", () => {
  it("renders the protocol as a label, not a monospace identifier", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/enterprise_connections")
          ? new Response(JSON.stringify({ data: [CONNECTION], total_count: 1 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : undefined,
    });
    renderPage(<Page />);

    const cell = (await screen.findByText("oidc")).closest("td")!;
    expect(cell.className).not.toContain("font-data");
    expect(cell.className).not.toContain("uppercase");
    expect(cell.className).toContain("font-medium");
  });
});
