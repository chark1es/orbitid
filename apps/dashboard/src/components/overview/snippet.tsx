import { cn } from "@orbitid/ui";

/** Code block for setup snippets: one rule, a filename in the header, mono body. */
export function Snippet({ title, code, className }: { title: string; code: string; className?: string }) {
  return (
    <figure className={cn("overflow-hidden rounded-[4px] border border-border bg-rail", className)}>
      <figcaption className="border-b border-white/10 px-3 py-1.5 font-data text-[0.6875rem] text-rail-muted">
        {title}
      </figcaption>
      <pre className="overflow-x-auto px-3 py-2.5 font-data text-[0.8125rem] leading-6 text-rail-foreground">{code}</pre>
    </figure>
  );
}
