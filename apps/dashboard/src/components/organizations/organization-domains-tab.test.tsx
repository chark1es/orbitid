import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OrganizationDomainJSON, OrganizationJSON } from "@orbitid/shared";
import { AddDomainDialog } from "./organization-domains-tab";
import { EnrollmentModeSelect } from "./_domains/enrollment-mode-select";

const ORG = { id: "org_1", name: "Acme" } as OrganizationJSON;
const DOMAIN = {
  id: "orgdom_1",
  name: "example.com",
  enrollment_mode: "manual_invitation",
} as OrganizationDomainJSON;

describe("organization domain enrollment select", () => {
  it("fills the dialog row instead of leaving a 190px stub", () => {
    render(<AddDomainDialog org={ORG} open onOpenChange={() => {}} onAdded={() => {}} />);
    const trigger = screen.getByLabelText("Enrollment mode");
    expect(trigger.className).toContain("w-full");
  });

  it("keeps a sensible fixed cap inline in the domains table", () => {
    render(
      <EnrollmentModeSelect
        orgId={ORG.id}
        domain={DOMAIN}
        onChanged={() => {}}
      />,
    );
    const trigger = screen.getByLabelText(/Enrollment mode for example.com/);
    expect(trigger.className).toContain("w-full");
    expect(trigger.className).toContain("max-w-[190px]");
  });
});
