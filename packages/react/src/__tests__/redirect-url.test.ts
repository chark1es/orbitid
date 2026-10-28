import { afterEach, describe, expect, it } from "vitest";
import { isValidRedirectUrl, safeRedirectUrlFromLocation } from "../lib/redirects";

function visit(search: string) {
  window.history.replaceState(null, "", `/sign-in${search}`);
}
const query = (value: string) => `?redirect_url=${encodeURIComponent(value)}`;

describe("safeRedirectUrlFromLocation", () => {
  afterEach(() => visit(""));

  it("returns nothing without a redirect_url", () => {
    visit("");
    expect(safeRedirectUrlFromLocation()).toBeUndefined();
  });

  it("follows a relative path and a same-origin URL", () => {
    visit(query("/account"));
    expect(safeRedirectUrlFromLocation()).toBe("/account");
    const sameOrigin = `${window.location.origin}/api-keys?tab=1#top`;
    visit(query(sameOrigin));
    expect(safeRedirectUrlFromLocation()).toBe(sameOrigin);
  });

  it("follows an allowlisted origin and no other", () => {
    visit(query("https://app.example.com/home"));
    expect(safeRedirectUrlFromLocation()).toBeUndefined();
    expect(safeRedirectUrlFromLocation({ allowedRedirectOrigins: ["https://app.example.com"] })).toBe("https://app.example.com/home");
  });

  it("drops anything a browser would read as another origin", () => {
    for (const target of ["https://evil.example/phish", "//evil.example/phish", "/\\evil.example", "/\t/evil.example", "\\\\evil.example", "javascript:alert(1)"]) {
      visit(query(target));
      expect(safeRedirectUrlFromLocation(), target).toBeUndefined();
    }
  });
});

describe("isValidRedirectUrl", () => {
  it("rejects control characters", () => {
    expect(isValidRedirectUrl("/ok\nx")).toBe(false);
    expect(isValidRedirectUrl("/ok")).toBe(true);
  });
});
