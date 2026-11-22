import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, cn } from "@orbitid/ui";
import { ArrowRight, Mail, X } from "lucide-react";
import { EMAIL_SETTINGS_HREF, useEmailNotConfigured } from "../../lib/email-delivery";

const DISMISS_KEY = "orbitid-email-banner-dismissed";

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    sessionStorage.setItem(DISMISS_KEY, "1");
  } catch {
    /* Storage can be blocked; the banner simply returns on the next render. */
  }
}

/**
 * Shell-wide prompt shown while the server has no mail transport. Sign-in codes, invitations and
 * password resets all depend on it, so it sits under the top bar on every page until email is set
 * up. It hides on the Email & SMS page itself and can be dismissed for the browser session.
 */
export function EmailSetupBanner() {
  const notConfigured = useEmailNotConfigured();
  const { pathname } = useLocation();
  const [dismissed, setDismissed] = useState(readDismissed);

  if (!notConfigured || dismissed || pathname.startsWith(EMAIL_SETTINGS_HREF)) return null;

  return (
    <div
      role="status"
      className="border-b border-border bg-card animate-in fade-in-0 slide-in-from-top-1 duration-200 ease-out-expo"
    >
      <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-3 gap-y-2 px-6 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-caution/40 text-caution">
          <Mail className="size-4" aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-[0.8125rem] leading-snug">
          <span className="font-semibold">Email delivery is not set up.</span>{" "}
          <span className="text-muted-foreground">
            Sign-in codes, invitations and password resets cannot reach anyone until you add Resend or SMTP.
          </span>
        </p>
        <div className="flex items-center gap-1">
          <Button asChild size="sm">
            <Link to={EMAIL_SETTINGS_HREF}>
              Set up email
              <ArrowRight className="size-3.5" aria-hidden />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Hide for this session"
            onClick={() => {
              writeDismissed();
              setDismissed(true);
            }}
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline version for flows that send mail (invitations, waitlist invites). Renders nothing while
 * email works, so callers can drop it in unconditionally.
 */
export function EmailSetupNotice({
  action = "send this email",
  className,
  onNavigate,
}: {
  /** Completes "OrbitID cannot ...". */
  action?: string;
  className?: string;
  /** Called before following the link, e.g. to close the dialog it sits in. */
  onNavigate?: () => void;
}) {
  const notConfigured = useEmailNotConfigured();
  if (!notConfigured) return null;
  return (
    <div
      role="note"
      className={cn("flex items-start gap-2.5 rounded-md border border-caution/50 px-3 py-2.5 text-[0.8125rem]", className)}
    >
      <Mail className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">Email delivery is not set up</p>
        <p className="leading-relaxed text-muted-foreground">
          OrbitID cannot {action} until a mail transport is configured. You can still copy the link and share it yourself.
        </p>
        <Link
          to={EMAIL_SETTINGS_HREF}
          onClick={onNavigate}
          className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
        >
          Open Email &amp; SMS settings
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
