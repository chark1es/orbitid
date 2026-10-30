import { describe, expect, it, vi } from "vitest";
import { trimCache } from "./trimCache";

describe("SDK response cache retention", () => {
  it("evicts expired responses and caps retained pages", () => {
    const now = Date.now();
    const cache = new Map([
      ["expired", { at: now - 6000 }],
      ["oldest", { at: now - 2000 }],
      ["newer", { at: now - 1000 }],
      ["latest", { at: now }],
    ]);
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      trimCache(cache, 5000, 2);
      expect([...cache.keys()]).toEqual(["newer", "latest"]);
    } finally { vi.restoreAllMocks(); }
  });
});
