import { afterEach, describe, expect, it } from "vitest";
import { redirectUrlFromQuery } from "../components/auth/_shared/guards";

function visit(search: string) {
  window.history.replaceState(null, "", `/sign-in${search}`);
}

describe("redirectUrlFromQuery", () => {
  afterEach(() => visit(""));

  it("returns nothing without a redirect_url", () => {
    visit("");
    expect(redirectUrlFromQuery()).toBeUndefined();
  });

  it("keeps a same-origin URL as a path", () => {
    visit(`?redirect_url=${encodeURIComponent(`${window.location.origin}/api-keys?tab=1#top`)}`);
    expect(redirectUrlFromQuery()).toBe("/api-keys?tab=1#top");
  });

  it("keeps a relative path", () => {
    visit("?redirect_url=%2Faccount");
    expect(redirectUrlFromQuery()).toBe("/account");
  });

  it("drops other origins and protocol-relative URLs", () => {
    visit("?redirect_url=https%3A%2F%2Fevil.example%2Fphish");
    expect(redirectUrlFromQuery()).toBeUndefined();
    visit("?redirect_url=%2F%2Fevil.example%2Fphish");
    expect(redirectUrlFromQuery()).toBeUndefined();
  });
});
