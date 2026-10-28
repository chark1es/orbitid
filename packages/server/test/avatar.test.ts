import { describe, expect, it } from "vitest";
import { DEFAULT_AVATAR } from "../src/serializers";

const decode = (url: string) => decodeURIComponent(url.replace("data:image/svg+xml;utf8,", ""));

describe("default avatar", () => {
  it("is generated locally from initials, with no external host", () => {
    const url = DEFAULT_AVATAR("Ada Lovelace");
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    const svg = decode(url);
    expect(svg).toContain(">AL<");
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toMatch(/https?:\/\//);
  });

  it("is stable for the same name and takes initials from an email address", () => {
    expect(DEFAULT_AVATAR("grace.hopper@example.com")).toBe(DEFAULT_AVATAR("grace.hopper@example.com"));
    expect(decode(DEFAULT_AVATAR("grace.hopper@example.com"))).toContain(">GH<");
    expect(decode(DEFAULT_AVATAR(""))).toContain(">?<");
  });

  it("escapes nothing dangerous into the image", () => {
    const svg = decode(DEFAULT_AVATAR("<script>alert(1)</script>"));
    expect(svg).not.toContain("<script");
    expect(svg).toMatch(/>[\p{L}\p{N}?]{1,2}<\/text>/u);
  });
});
