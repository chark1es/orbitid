import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@orbitid/ui";
import { toast } from "sonner";
import { getApiUrl } from "../../lib/api";
import { databaseLabel, fetchInstanceHealth, type InstanceHealth } from "../../lib/instance-health";
import { useCopyToClipboard } from "../../lib/hooks";

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
  const [copied, setCopied] = useState(false);

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

  return (
    <div className={className}>
      <span
        className="inline-flex h-7 max-w-[7rem] items-center gap-1.5 rounded-sm border border-border bg-card px-2 font-data text-xs text-foreground sm:max-w-[11rem] md:max-w-none"
        title={`${database} · ${apiUrl}`}
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${unreachable ? "bg-signal" : health ? "bg-go" : "bg-caution"}`}
        />
        <span className="truncate">{database}</span>
        <span className="hidden text-muted-foreground md:inline">·</span>
        <span className="hidden max-w-[16ch] truncate text-muted-foreground md:inline">{hostOf(apiUrl)}</span>
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
          setCopied(true);
          toast.success("API URL copied");
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
    </div>
  );
}
