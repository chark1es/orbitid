import { describe, expect, it } from "vitest";
import { compileRoutePattern, createRouteMatcher } from "../src/route-matcher";

const request = (url: string) => ({ url: `https://app.test${url}` });

describe("compileRoutePattern", () => {
  it("supports Clerk-style inline groups", () => {
    const matcher = createRouteMatcher(["/dashboard(.*)"]);
    expect(matcher(request("/dashboard"))).toBe(true);
    expect(matcher(request("/dashboard/settings"))).toBe(true);
    expect(matcher(request("/dashboard/settings/org"))).toBe(true);
    expect(matcher(request("/other"))).toBe(false);
  });

  it("supports :param segments", () => {
    const matcher = createRouteMatcher(["/api/:id"]);
    expect(matcher(request("/api/123"))).toBe(true);
    expect(matcher(request("/api/123/extra"))).toBe(false);
    expect(matcher(request("/api"))).toBe(false);
  });

  it("supports :param* catch-all including the bare prefix", () => {
    const matcher = createRouteMatcher(["/api/:path*"]);
    expect(matcher(request("/api"))).toBe(true);
    expect(matcher(request("/api/users/1"))).toBe(true);
    expect(matcher(request("/apix"))).toBe(false);
  });

  it("supports :param+ requiring at least one segment", () => {
    const matcher = createRouteMatcher(["/docs/:path+"]);
    expect(matcher(request("/docs"))).toBe(false);
    expect(matcher(request("/docs/intro"))).toBe(true);
  });

  it("matches single- and double-star globs", () => {
    expect(createRouteMatcher(["/files/*.png"])(request("/files/logo.png"))).toBe(true);
    expect(createRouteMatcher(["/files/*.png"])(request("/files/nested/logo.png"))).toBe(false);
    expect(createRouteMatcher(["/admin/**"])(request("/admin/a/b"))).toBe(true);
    expect(createRouteMatcher(["/admin/**"])(request("/admin"))).toBe(false);
  });

  it("escapes dots", () => {
    expect(compileRoutePattern("/a.b").test("/a.b")).toBe(true);
    expect(compileRoutePattern("/a.b").test("/axb")).toBe(false);
  });
});

describe("createRouteMatcher", () => {
  it("accepts a single string, a RegExp, or a predicate", () => {
    expect(createRouteMatcher("/private")(request("/private"))).toBe(true);
    expect(createRouteMatcher(/^\/admin(\/|$)/)(request("/admin/users"))).toBe(true);
    expect(createRouteMatcher((req) => req.url.includes("token"))(request("/reset?token=1"))).toBe(true);
  });

  it("ORs arrays and ignores the query string", () => {
    const matcher = createRouteMatcher(["/dashboard(.*)", /^\/account$/]);
    expect(matcher(request("/account?tab=security"))).toBe(true);
    expect(matcher(request("/dashboard?tab=billing"))).toBe(true);
    expect(matcher(request("/pricing"))).toBe(false);
  });

  it("uses nextUrl.pathname when provided", () => {
    const matcher = createRouteMatcher(["/dashboard(.*)"]);
    expect(matcher({ url: "https://app.test/ignored", nextUrl: { pathname: "/dashboard" } })).toBe(true);
  });
});
