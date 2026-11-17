import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@orbitid/ui";
import { toast } from "sonner";
import { getApiUrl } from "../../lib/api";
import { databaseLabel, databaseSupportNote, fetchInstanceHealth, type InstanceHealth } from "../../lib/instance-health";
import { useCopyToClipboard, useFlash } from "../../lib/hooks";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** `<database> · <host>` for the instance the dashboard is pointed at. */
export function InstanceChip({ className }: { className?: string }) {
  const apiUrl = getApiUrl();
  const copy = useCopyToClipboard();
  const [health, setHealth] = useState<InstanceHealth | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [copied, flashCopied] = useFlash(1500);

  useEffect(() => {
    const controller = new AbortController();
    setUnreachable(false);
    fetchInstanceHealth(apiUrl, controller.signal)
      .then((result) => {
        setHealth(result);
        setUnreachable(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setHealth(null);
        setUnreachable(true);
      });
    return () => controller.abort();
  }, [apiUrl]);

  const database = health ? databaseLabel(health.database) : unreachable ? "Unreachable" : "Checking";
  const supportNote = health ? databaseSupportNote(health.database, health.databaseDriver) : null;

  return (
    <div className={className}>
      <span
        className="inline-flex h-7 min-w-0 max-w-[9rem] items-center gap-1.5 rounded-sm border border-border bg-card px-2 font-data text-xs text-foreground sm:max-w-[11rem] lg:max-w-[16rem]"
        title={`${database} · ${apiUrl}${supportNote ? ` — ${supportNote}` : ""}`}
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${unreachable ? "bg-signal" : health ? "bg-go" : "bg-caution"}`}
        />
        {/* Below lg the breadcrumb needs the room more than the URL does: the chip keeps the short
            environment/database label and the host moves into the tooltip (and the instance sheet). */}
        <span className="min-w-0 shrink-0 truncate">{database}</span>
        <span className="hidden shrink-0 text-muted-foreground lg:inline">·</span>
        <span className="hidden min-w-0 flex-1 truncate text-muted-foreground lg:inline">{hostOf(apiUrl)}</span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Copy API URL"
        title="Copy API URL"
        className="ml-0.5 hidden text-muted-foreground sm:inline-flex"
        onClick={async () => {
          const ok = await copy(apiUrl);
          if (!ok) {
            toast.error("Could not copy the API URL");
            return;
          }
          flashCopied();
          toast.success("API URL copied");
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}
