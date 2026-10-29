import { describe, expect, it } from "vitest";
import { buildHasProbe, describeHasResult } from "./has";

describe("buildHasProbe", () => {
  it("builds a role probe and shows the call it performs", () => {
    expect(buildHasProbe("role", " org:admin ")).toEqual({
      ok: true,
      params: { role: "org:admin" },
      expression: 'has({ role: "org:admin" })',
    });
  });

  it("builds a permission probe", () => {
    expect(buildHasProbe("permission", "org:sys_memberships:manage")).toMatchObject({
      ok: true,
      params: { permission: "org:sys_memberships:manage" },
    });
  });

  it("rejects a blank value with an example for the field", () => {
    expect(buildHasProbe("role", "  ")).toEqual({
      ok: false,
      error: "Enter a role, for example org:admin.",
    });
    expect(buildHasProbe("permission", "")).toEqual({
      ok: false,
      error: "Enter a permission, for example org:sys_memberships:manage.",
    });
  });

  it("rejects values with spaces", () => {
    expect(buildHasProbe("permission", "org:sys memberships")).toEqual({
      ok: false,
      error: "Remove the spaces. Roles and permissions have no spaces.",
    });
  });
});

describe("describeHasResult", () => {
  it("names the outcome in words", () => {
    expect(describeHasResult(true).word).toBe("Allowed");
    expect(describeHasResult(false).word).toBe("Denied");
    expect(describeHasResult(false).detail).toContain("does not carry");
  });
});
