import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { UpdateIndicator } from "./update-indicator";
import { parseRelease } from "../../lib/release";
import { instanceBody, mockApi, renderPage } from "../../pages/_config/__tests__/harness";

const NOTES = "https://github.com/chark1es/orbitid/releases/tag/v0.2.0";

function withVersion(version: Record<string, unknown> | undefined) {
  return version === undefined ? instanceBody() : { ...instanceBody(), version };
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("parseRelease", () => {
  it("reads the server's answer and refuses links outside OrbitID's release notes", () => {
    const status = parseRelease({
      version: { current: "0.1.0", latest: "0.2.0", update_available: true, release_url: NOTES },
    });
    expect(status).toEqual({ current: "0.1.0", latest: "0.2.0", updateAvailable: true, releaseUrl: NOTES });
    expect(
      parseRelease({ version: { current: "0.1.0", latest: "0.2.0", update_available: true, release_url: "https://evil.example" } })
        .releaseUrl,
    ).toBeNull();
    expect(parseRelease({}).updateAvailable).toBe(false);
    expect(parseRelease({ version: { update_available: true } }).updateAvailable).toBe(false);
  });
});

describe("UpdateIndicator", () => {
  it("links to the release notes when a newer release exists", async () => {
    mockApi({
      instance: withVersion({
        current: "0.1.0",
        update_check: true,
        latest: "0.2.0",
        update_available: true,
        release_url: NOTES,
        checked_at: 1,
      }),
    });
    renderPage(<UpdateIndicator />);

    const link = await screen.findByRole("link", { name: /update available: v0\.1\.0 to v0\.2\.0/i });
    expect(link.getAttribute("href")).toBe(NOTES);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("title")).toBe("Update available: v0.1.0 → v0.2.0. Open the release notes.");
  });

  it.each([
    ["the instance is current", { current: "0.2.0", update_check: true, latest: "0.2.0", update_available: false, release_url: NOTES }],
    ["the check is off", { current: "0.1.0", update_check: false, latest: null, update_available: false, release_url: null }],
    ["the server has no answer yet", { current: "0.1.0", update_check: true, latest: null, update_available: false, release_url: null }],
    ["the server is too old to report it", undefined],
  ])("renders nothing when %s", async (_case, version) => {
    const calls = mockApi({ instance: withVersion(version) });
    const { container } = renderPage(<UpdateIndicator />);
    await waitFor(() => expect(calls.some((call) => call.url.includes("/v1/instance"))).toBe(true));
    // Let the query settle before asserting the absence.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
