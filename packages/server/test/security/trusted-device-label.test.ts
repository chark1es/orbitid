import { describe, expect, it } from "vitest";
import { trustedDeviceLabel } from "../../src/services/trusted-devices";

describe("trusted device labels", () => {
  it.each([
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", "Safari on macOS"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0", "Edge on Windows"],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0", "Firefox on Linux"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "Safari on iOS"],
    ["", "Trusted browser"],
    ["curl/8.5.0", "Trusted browser"],
  ])("labels %s", (agent, label) => {
    expect(trustedDeviceLabel(agent)).toBe(label);
  });

  it("keeps hostile user agents to a fixed vocabulary", () => {
    expect(trustedDeviceLabel("<script>alert(1)</script>\r\nSet-Cookie: x=1 Firefox")).toBe("Firefox");
  });
});
