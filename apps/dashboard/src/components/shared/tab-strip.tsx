import { useEffect, useRef, useState } from "react";
import { TabsList, TabsTrigger, cn } from "@orbitid/ui";

/** Which edges of the scroll box are hiding content. */
export function scrollerEdges(el: { scrollLeft: number; clientWidth: number; scrollWidth: number }) {
  return {
    start: el.scrollLeft > 1,
    end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  };
}

/**
 * Underlined tab row. The active mark is an inset ink rule, so it survives horizontal scrolling on
 * narrow screens; the primitive's own underline sits outside the scroll box. Signal red stays
 * reserved for the rail's active item and failures.
 *
 * When the tabs overflow, a mask fades the hidden edge so the row reads as scrollable. The mask is
 * only applied while there is content past that edge, and the active tab is scrolled into view so a
 * deep link such as `?tab=danger` lands on a visible tab.
 */
export function TabStrip({
  tabs,
  value,
  className,
}: {
  tabs: readonly { value: string; label: string }[];
  value?: string;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setEdges(scrollerEdges(el));
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (!value) return;
    const el = scroller.current;
    const active = el?.querySelector<HTMLElement>('[data-state="active"]');
    if (!el || !active) return;
    // Scroll the strip itself. `scrollIntoView` also scrolls every ancestor, so a deep link such
    // as `?tab=danger` would move the whole page as soon as the tab row mounts.
    const start = active.offsetLeft;
    const end = start + active.offsetWidth;
    const left =
      start < el.scrollLeft
        ? start
        : end > el.scrollLeft + el.clientWidth
          ? end - el.clientWidth
          : el.scrollLeft;
    if (left !== el.scrollLeft) el.scrollTo?.({ left, behavior: "smooth" });
  }, [value]);

  const mask = edges.start
    ? edges.end
      ? "linear-gradient(to right, transparent, black 16px, black calc(100% - 16px), transparent)"
      : "linear-gradient(to right, transparent, black 16px)"
    : edges.end
      ? "linear-gradient(to right, black calc(100% - 16px), transparent)"
      : undefined;

  return (
    // The mask sits on the static wrapper so an edge fade stays at the visible edge while scrolling.
    <div className={cn("relative", className)} style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}>
      <div
        ref={scroller}
        data-slot="tab-strip-scroll"
        // The underline sits 1px below the trigger; `overflow-y-hidden` keeps that from becoming a
        // vertical scroll thumb. The native scrollbar is hidden because the edge fade is the affordance.
        className="w-full overflow-x-auto overflow-y-hidden border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <TabsList variant="line" className="h-auto w-full justify-start gap-5 p-0">
          {tabs.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="h-auto flex-none rounded-none px-0 pt-1.5 pb-2 text-[0.8125rem] after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-transparent data-[state=active]:text-foreground data-[state=active]:after:bg-foreground"
            >
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
    </div>
  );
}
