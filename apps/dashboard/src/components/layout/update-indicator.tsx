import { ArrowRight } from "lucide-react";
import { cn } from "@orbitid/ui";
import { displayVersion, useRelease } from "../../lib/release";

/**
 * Top-bar note that a newer OrbitID release exists, linking to its release notes. Renders nothing while the
 * instance is current, while the check is off, or before the server has an answer. Info tone, not signal red:
 * an update is news, not a failure.
 */
export function UpdateIndicator({ className }: { className?: string }) {
  const { data } = useRelease();
  if (!data?.updateAvailable || !data.latest || !data.releaseUrl) return null;

  const latest = displayVersion(data.latest);
  const current = data.current ? displayVersion(data.current) : null;
  const summary = current ? `Update available: ${current} → ${latest}` : `Update available: ${latest}`;

  return (
    <a
      href={data.releaseUrl}
      target="_blank"
      rel="noreferrer"
      title={`${summary}. Open the release notes.`}
      aria-label={`${current ? `Update available: ${current} to ${latest}` : `Update available: ${latest}`}. Release notes open in a new tab.`}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-sm border border-info/35 bg-info/10 px-2 text-xs font-medium text-foreground transition-colors hover:bg-info/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-info" />
      <span className="sm:hidden">Update</span>
      <span className="hidden sm:inline">Update available</span>
      {current ? (
        <span className="hidden items-center gap-1 font-data text-muted-foreground xl:inline-flex">
          {current}
          <ArrowRight className="size-3" aria-hidden />
          <span className="text-foreground">{latest}</span>
        </span>
      ) : null}
    </a>
  );
}
