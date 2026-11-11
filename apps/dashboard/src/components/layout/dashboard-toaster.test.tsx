import { describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { render } from "@testing-library/react";
import { toast } from "sonner";
import { DashboardToaster, TOASTER_OFFSET, TOASTER_POSITION } from "./dashboard-toaster";

describe("dashboard toaster", () => {
  it("anchors toasts under the top bar so sheet footers stay clickable", async () => {
    render(<DashboardToaster />);
    toast.error("Preview toast");

    let toaster: HTMLElement | null = null;
    await waitFor(() => {
      toaster = document.querySelector("[data-sonner-toaster]");
      expect(toaster).toBeTruthy();
    });

    expect(toaster!.getAttribute("data-y-position")).toBe("top");
    expect(toaster!.getAttribute("data-x-position")).toBe("right");
    // 56px clears the 48px bar; the offset is not the browser default zero.
    expect(TOASTER_POSITION).toBe("top-right");
    expect(TOASTER_OFFSET.top).toBeGreaterThanOrEqual(48);
    await waitFor(() => expect(toaster!.style.getPropertyValue("--offset-top")).toBe("56px"));
  });
});
