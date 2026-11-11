import { describe, expect, it } from "vitest";
import { OVERLAY_WIDTH } from "./overlay-sizes";

describe("overlay width tokens", () => {
  it("offers only 448, 576 and 768px overlays", () => {
    // sm:max-w-md = 28rem = 448px, xl = 36rem = 576px, 3xl = 48rem = 768px.
    expect(OVERLAY_WIDTH.form).toBe("sm:max-w-md");
    expect(OVERLAY_WIDTH.sheet).toBe("sm:max-w-xl");
    expect(OVERLAY_WIDTH.detail).toBe("sm:max-w-3xl");
    expect(new Set(Object.values(OVERLAY_WIDTH)).size).toBe(3);
  });
});
