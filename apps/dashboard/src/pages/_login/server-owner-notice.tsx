import { Terminal } from "lucide-react";
import { CopyButton } from "../../components/shared/copy-button";

/**
 * Accounts exist but none can open the console (an instance from before owners, or one whose owners lost access).
 * The secret key does not open the dashboard, so the way in is on the server itself.
 */
export function ServerOwnerNotice({ email }: { email?: string | null }) {
  const command = `orbitid owner ${email || "you@example.com"}`;
  return (
    <div role="note" className="rounded-md border border-border bg-muted/40 px-3 py-3 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <Terminal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        No account can open the console yet
      </p>
      <p className="mt-1 pl-6 text-muted-foreground">
        Whoever runs the server makes an account its owner with this command, then that account signs in here. Use a
        verified email address or a user id.
      </p>
      <div className="mt-2 ml-6 flex items-center gap-1 rounded-sm border border-border bg-background py-1 pr-1 pl-2">
        <code className="min-w-0 flex-1 truncate font-data text-xs">{command}</code>
        <CopyButton value={command} label="Copy command" />
      </div>
    </div>
  );
}
