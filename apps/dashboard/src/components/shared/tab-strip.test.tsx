import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tabs } from "@orbitid/ui";
import { TabStrip, scrollerEdges } from "./tab-strip";

const TABS = [
  { value: "profile", label: "Profile" },
  { value: "identifiers", label: "Identifiers" },
  { value: "security", label: "Security" },
  { value: "sessions", label: "Sessions" },
  { value: "devices", label: "Trusted devices" },
  { value: "organizations", label: "Organizations" },
  { value: "roles", label: "Roles" },
  { value: "metadata", label: "Metadata" },
  { value: "activity", label: "Activity" },
  { value: "danger", label: "Danger zone" },
];

type Proto = HTMLElement & { offsetLeft: number; offsetWidth: number; clientWidth: number; scrollLeft: number };

const saved = new Map<string, PropertyDescriptor | undefined>();

function override(name: string, descriptor: PropertyDescriptor) {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  saved.set(name, Object.getOwnPropertyDescriptor(proto, name));
  Object.defineProperty(proto, name, { configurable: true, ...descriptor });
}

afterEach(() => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(proto, name, descriptor);
    else delete proto[name];
  }
  saved.clear();
});

describe("scrollerEdges", () => {
  it("reports only the edges that hide content", () => {
    expect(scrollerEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: false, end: true });
    expect(scrollerEdges({ scrollLeft: 150, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: true, end: true });
    expect(scrollerEdges({ scrollLeft: 300, clientWidth: 300, scrollWidth: 600 })).toEqual({ start: true, end: false });
    expect(scrollerEdges({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toEqual({ start: false, end: false });
  });
});

describe("TabStrip", () => {
  it("scrolls only the strip, not the page, when a deep link opens a hidden tab", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const scrollTo = vi.fn();
    override("offsetLeft", {
      get(this: Proto) {
        return this.getAttribute("data-state") === "active" ? 420 : 0;
      },
    });
    override("offsetWidth", {
      get(this: Proto) {
        return this.getAttribute("data-state") === "active" ? 90 : 0;
      },
    });
    override("clientWidth", {
      get(this: Proto) {
        return this.getAttribute("data-slot") === "tab-strip-scroll" ? 300 : 90;
      },
    });
    override("scrollLeft", { get: () => 0 });
    override("scrollTo", { writable: true, value: scrollTo });

    render(
      <Tabs value="danger">
        <TabStrip tabs={TABS} value="danger" />
      </Tabs>,
    );

    const active = screen.getByRole("tab", { name: "Danger zone" });
    expect(active.getAttribute("data-state")).toBe("active");
    // The active tab ends at 510px inside a 300px viewport, so the strip scrolls to 210px.
    expect(scrollTo).toHaveBeenCalledWith({ left: 210, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("centres the label with the corrected vertical padding", () => {
    render(
      <Tabs value="profile">
        <TabStrip tabs={TABS} value="profile" />
      </Tabs>,
    );
    const tab = screen.getByRole("tab", { name: "Profile" });
    expect(tab.className).toContain("pt-1.5");
    expect(tab.className).toContain("pb-2");
    expect(tab.className).not.toContain("pb-2.5");
  });

  it("hides the native scrollbar while keeping scroll and the edge fade", () => {
    const { container } = render(
      <Tabs value="profile">
        <TabStrip tabs={TABS} value="profile" />
      </Tabs>,
    );
    const scroller = container.querySelector('[data-slot="tab-strip-scroll"]')!;
    // A stray thumb appeared next to tab rows that fit; the 1px underline was the vertical overflow.
    expect(scroller.className).toContain("[scrollbar-width:none]");
    expect(scroller.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(scroller.className).toContain("overflow-y-hidden");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("w-full");
  });
});
