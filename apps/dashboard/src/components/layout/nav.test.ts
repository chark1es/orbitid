import { describe, expect, it } from "vitest";
import { NAV_GROUPS, visibleNavGroups } from "./nav";

const titles = (organizations: boolean) =>
  visibleNavGroups({ organizations }).flatMap((group) => group.items.map((item) => item.title));

describe("visibleNavGroups", () => {
  it("keeps every entry while organizations are on", () => {
    expect(titles(true)).toEqual(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.title)));
  });

  it("drops the organization pages while they are off, but keeps the setting that turns them on", () => {
    const hidden = titles(false);
    expect(hidden).toContain("Roles & permissions");
    expect(hidden).not.toContain("Organizations");
    expect(hidden).toContain("Organization settings");
    const settings = visibleNavGroups({ organizations: false })
      .flatMap((group) => group.items)
      .find((item) => item.title === "Organization settings");
    expect(settings?.href).toBe("/settings/organizations");
  });

  it("gives the Manage pages and their Configure settings pages distinct rail labels", () => {
    const all = titles(true);
    expect(all.filter((title) => title === "Sessions")).toHaveLength(1);
    expect(all.filter((title) => title === "Organizations")).toHaveLength(1);
    expect(all).toContain("Session settings");
    expect(all).toContain("Organization settings");
  });
});
