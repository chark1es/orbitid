import { TabsList, TabsTrigger, cn } from "@orbitid/ui";

/**
 * Underlined tab row. The active mark is an inset signal rule, so it survives horizontal
 * scrolling on narrow screens; the primitive's own underline sits outside the scroll box.
 */
export function TabStrip({
  tabs,
  className,
}: {
  tabs: readonly { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className={cn("overflow-x-auto border-b border-border", className)}>
      <TabsList variant="line" className="h-auto w-full justify-start gap-5 p-0">
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            className="h-auto flex-none rounded-none px-0 pb-2.5 pt-1 text-[0.8125rem] data-[state=active]:text-foreground data-[state=active]:shadow-[inset_0_-2px_0_0_var(--signal)]"
          >
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}
