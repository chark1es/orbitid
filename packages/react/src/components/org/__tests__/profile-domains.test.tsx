import { beforeEach, describe, expect, test } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { resetVirtualRouter } from "../../../lib/routing";
import { OrganizationProfile } from "../OrganizationProfile";
import { createFakeInstance, renderWithOrbit } from "./harness";

beforeEach(() => {
  resetVirtualRouter();
});

async function addDomain(fake: ReturnType<typeof createFakeInstance>, name = "acme.com") {
  renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);
  const input = await screen.findByLabelText("Domain");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
  expect(await screen.findByText("Pending verification")).toBeTruthy();
}

describe("<OrganizationProfile /> domains", () => {
  test("adds a domain and rejects malformed domain names", async () => {
    const fake = createFakeInstance();
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    const input = await screen.findByLabelText("Domain");
    fireEvent.change(input, { target: { value: "not a domain" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect(await screen.findByText("Enter a valid domain, e.g. example.com.")).toBeTruthy();
    expect(fake.backend.domains[fake.backend.orgs[0]!.id]).toHaveLength(0);

    fireEvent.change(input, { target: { value: "acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add domain" }));
    expect(await screen.findByText("acme.com")).toBeTruthy();
    expect(fake.backend.domains[fake.backend.orgs[0]!.id]).toHaveLength(1);
  });

  test("verifies a domain with the affiliation email code", async () => {
    const fake = createFakeInstance();
    await addDomain(fake);

    fireEvent.click(await screen.findByRole("button", { name: "Verify domain" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Verify acme.com")).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Verification email address"), {
      target: { value: "me@acme.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send code" }));
    expect(await within(dialog).findByText("We sent a code to me@acme.com.")).toBeTruthy();

    const codeInput = within(dialog).getByLabelText("Verification code");
    fireEvent.change(codeInput, { target: { value: "000000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Verify domain" }));
    expect(await within(dialog).findByText("Incorrect code. Please try again.")).toBeTruthy();

    fireEvent.change(codeInput, { target: { value: "123456" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Verify domain" }));

    await waitFor(() =>
      expect(fake.backend.domains[fake.backend.orgs[0]!.id]?.[0]?.verified).toBe(true),
    );
    expect(await screen.findByText("Verified")).toBeTruthy();
  });

  test("updates the enrollment mode with the delete-pending option", async () => {
    const fake = createFakeInstance();
    const orgId = fake.backend.orgs[0]!.id;
    fake.backend.domains[orgId] = [
      { id: "domain_1", name: "acme.com", enrollmentMode: "manual_invitation", verified: true },
    ];
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    expect(await screen.findByText("acme.com")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Automatic invitation"));
    fireEvent.click(screen.getByLabelText("Delete pending invitations and suggestions"));
    fireEvent.click(screen.getByRole("button", { name: "Update enrollment mode" }));

    await waitFor(() =>
      expect(
        fake.backend.calls.fetch.some(
          (call) =>
            call.method === "ENROLLMENT" &&
            JSON.stringify(call.body) ===
              JSON.stringify({ enrollmentMode: "automatic_invitation", deletePending: true }),
        ),
      ).toBe(true),
    );
  });

  test("removes a domain after confirmation", async () => {
    const fake = createFakeInstance();
    const orgId = fake.backend.orgs[0]!.id;
    fake.backend.domains[orgId] = [
      { id: "domain_1", name: "acme.com", enrollmentMode: "manual_invitation", verified: false },
    ];
    renderWithOrbit(<OrganizationProfile routing="virtual" />, fake);

    await screen.findByText("acme.com");
    fireEvent.click(screen.getByRole("button", { name: "Remove domain acme.com" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove domain" }));

    await waitFor(() => expect(fake.backend.domains[orgId]).toHaveLength(0));
  });
});
