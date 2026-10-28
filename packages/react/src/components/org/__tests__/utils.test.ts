import { describe, expect, test } from "vitest";
import {
  ORG_PERMISSIONS,
  dedupeEmails,
  hasPermission,
  initials,
  isValidDomain,
  isValidEmail,
  roleLabel,
  slugify,
  splitEmails,
} from "../_shared/utils";

describe("org component utilities", () => {
  test("slugify produces URL-safe, accent-free slugs", () => {
    expect(slugify("Acme Inc.")).toBe("acme-inc");
    expect(slugify("Café Ünïcode")).toBe("cafe-unicode");
    expect(slugify("  --Hello   World-- ")).toBe("hello-world");
    expect(slugify("a".repeat(80))).toHaveLength(64);
  });

  test("initials uses at most two letters", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Acme")).toBe("AC");
    expect(initials("")).toBe("?");
    expect(initials("@#$")).toBe("?");
  });

  test("domain and email validation", () => {
    expect(isValidDomain("example.com")).toBe(true);
    expect(isValidDomain("sub.example.co.uk")).toBe(true);
    expect(isValidDomain("example")).toBe(false);
    expect(isValidDomain("-bad.com")).toBe(false);
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
  });

  test("email helpers dedupe case-insensitively and split pasted lists", () => {
    expect(dedupeEmails(["A@b.co", "a@B.co", " ", "c@d.co"])).toEqual(["A@b.co", "c@d.co"]);
    expect(splitEmails("a@b.co, c@d.co\ne@f.co;g@h.co")).toEqual([
      "a@b.co",
      "c@d.co",
      "e@f.co",
      "g@h.co",
    ]);
  });

  test("permission checks follow the role and permission contract", () => {
    const admin = { role: "org:admin", permissions: [ORG_PERMISSIONS.profileManage] };
    const member = { role: "org:member", permissions: [] };
    expect(hasPermission(admin, ORG_PERMISSIONS.profileManage)).toBe(true);
    expect(hasPermission(admin, ORG_PERMISSIONS.domainsManage)).toBe(false);
    expect(hasPermission(member, ORG_PERMISSIONS.profileManage)).toBe(false);
    expect(hasPermission({ role: "org:admin" }, ORG_PERMISSIONS.profileDelete)).toBe(true);
    expect(hasPermission({ role: "org:member" }, ORG_PERMISSIONS.profileDelete)).toBe(false);
    expect(hasPermission(null, ORG_PERMISSIONS.profileDelete)).toBe(false);
  });

  test("roleLabel prefers the API name, then system keys, then the raw key", () => {
    const t = (key: string) => (key === "membershipRole__admin" ? "Admin" : key);
    expect(roleLabel("org:admin", "Owner", t)).toBe("Owner");
    expect(roleLabel("org:admin", undefined, t)).toBe("Admin");
    expect(roleLabel("org:custom", undefined, t)).toBe("org:custom");
  });
});
