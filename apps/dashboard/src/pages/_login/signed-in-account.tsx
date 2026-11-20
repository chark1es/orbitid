import { useState } from "react";
import { Button } from "@orbitid/ui";
import { ArrowRight, Loader2, LogOut, ShieldAlert, ShieldCheck } from "lucide-react";
import { accountLabel, useAuth, type ConsoleAccount } from "../../lib/auth";
import { errorMessage } from "../../lib/errors";
import { UserAvatar } from "../../components/shared/user-avatar";
import { FormError } from "./form-error";
import { ServerOwnerNotice } from "./server-owner-notice";

/** Someone is already signed in to this instance in this browser: say who, and what they can do here. */
export function SignedInAccount({
  account,
  unclaimed = false,
  onOpened,
}: {
  account: ConsoleAccount;
  /** No account can open the console yet: point at the server-side grant instead of "ask an owner". */
  unclaimed?: boolean;
  onOpened: () => void;
}) {
  const { openConsole, signOut } = useAuth();
  const [pending, setPending] = useState<"open" | "sign-out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = accountLabel(account);

  async function open() {
    setError(null);
    setPending("open");
    try {
      await openConsole();
      onOpened();
    } catch (cause) {
      setError(errorMessage(cause, "The instance did not answer. Try again."));
    } finally {
      setPending(null);
    }
  }

  async function leave() {
    setError(null);
    setPending("sign-out");
    try {
      await signOut({ account: true });
    } catch (cause) {
      setError(errorMessage(cause, "The instance did not answer. You are still signed in; try again."));
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <h1 id="sign-in-heading" className="text-[1.75rem] leading-tight">
        {account.console_access ? "You are signed in" : "No access to the console"}
      </h1>
      <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
        {account.console_access
          ? "Your account can manage this instance."
          : unclaimed
            ? "This account is signed in, but none of its roles opens the admin console, and no other account's do either."
            : "This account is signed in, but none of its roles opens the admin console. Ask an owner to give it the Administrator role, or sign in with a different account."}
      </p>
      {!account.console_access && unclaimed ? (
        <div className="mt-6">
          <ServerOwnerNotice email={account.email_address} />
        </div>
      ) : null}

      <div className="mt-8 flex items-center gap-3 rounded-md border border-border px-3 py-3">
        <UserAvatar name={label} imageUrl={account.image_url} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{label}</p>
          {account.email_address && account.email_address !== label ? (
            <p className="truncate text-sm text-muted-foreground">{account.email_address}</p>
          ) : null}
        </div>
        {account.console_access ? (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5 text-go" aria-hidden /> Console access
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <ShieldAlert className="size-3.5 text-signal" aria-hidden /> No console access
          </span>
        )}
      </div>

      {error ? (
        <div className="mt-5">
          <FormError id="account-error" title="Something went wrong" message={error} />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        {account.console_access ? (
          <Button className="sm:flex-1" onClick={() => void open()} disabled={pending !== null} autoFocus>
            {pending === "open" ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Open the admin console
            {pending === "open" ? null : <ArrowRight aria-hidden />}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => void leave()} disabled={pending !== null}>
          {pending === "sign-out" ? <Loader2 className="animate-spin" aria-hidden /> : <LogOut aria-hidden />}
          Sign out
        </Button>
      </div>
    </>
  );
}
