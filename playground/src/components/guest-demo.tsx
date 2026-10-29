"use client";

import * as React from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Button, Input } from "@orbitid/ui";
import { useAuth, useOrbitID, useSignUp, useUser } from "@orbitid/react";
import { CopyButton } from "./copy-button";
import { StatusChip } from "./status-chip";
import { decodeJwt } from "@/lib/jwt";

type Phase =
  | { kind: "idle" }
  | { kind: "creating" }
  | { kind: "created"; userId: string | null; sessionId: string }
  | { kind: "error"; message: string };

/**
 * `SignUpResource`, `EmailAddressResource` and the instance in `@orbitid/react` describe these calls as
 * `unknown` (their index signature wins over the missing method). The shapes below are the documented SDK
 * API from `@orbitid/js`; a cast here keeps the demo typed without reaching into the SDK packages.
 */
interface AnonymousSignUp {
  createdSessionId?: string | null;
  createdUserId?: string | null;
  createAnonymous(params?: { unsafeMetadata?: Record<string, unknown> }): Promise<AnonymousSignUp>;
}

interface VerifiableEmail {
  emailAddress: string;
  prepareVerification(params?: { strategy?: string }): Promise<unknown>;
  attemptVerification(params: { code: string }): Promise<unknown>;
}

interface RefreshableInstance {
  refreshClient?: () => Promise<unknown>;
}

type UpgradePhase =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "code-sent"; email: string }
  | { kind: "verifying" }
  | { kind: "verified"; email: string }
  | { kind: "error"; message: string };

function DataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="font-data text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The request failed without an error message.";
}

interface Props {
  /** Label of the transport that will deliver the verification code, when the secret key can read it. */
  emailTransport: string | null;
}

export function GuestDemo({ emailTransport }: Props) {
  const { signUp, setActive, isLoaded } = useSignUp();
  const { user, isAnonymous } = useUser();
  const { isSignedIn, getToken } = useAuth({ treatPendingAsSignedOut: false });
  const instance = useOrbitID();

  const [phase, setPhase] = React.useState<Phase>({ kind: "idle" });
  const [claim, setClaim] = React.useState<{ token: boolean | null; error: string | null }>({
    token: null,
    error: null,
  });
  const [upgrade, setUpgrade] = React.useState<UpgradePhase>({ kind: "idle" });
  const [email, setEmail] = React.useState("");
  const [code, setCode] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);

  /** Reads the `anonymous` claim from a freshly minted token, so the page shows what the server signed. */
  const readClaim = React.useCallback(async () => {
    if (!isSignedIn) {
      setClaim({ token: null, error: null });
      return;
    }
    try {
      const token = await getToken({ skipCache: true });
      if (!token) {
        setClaim({ token: null, error: "The instance returned no token for this session." });
        return;
      }
      const decoded = decodeJwt(token);
      if (!decoded.ok) {
        setClaim({ token: null, error: decoded.error });
        return;
      }
      setClaim({ token: decoded.jwt.claims.anonymous === true, error: null });
    } catch (error) {
      setClaim({ token: null, error: describeError(error) });
    }
  }, [getToken, isSignedIn]);

  React.useEffect(() => {
    void readClaim();
  }, [readClaim]);

  async function createGuest() {
    if (!signUp) return;
    setPhase({ kind: "creating" });
    setUpgrade({ kind: "idle" });
    try {
      const attempt = await (signUp as unknown as AnonymousSignUp).createAnonymous();
      const sessionId = attempt.createdSessionId ?? null;
      if (!sessionId) {
        setPhase({
          kind: "error",
          message:
            "The sign-up completed without a session. Guest sign-up is refused while anonymous.enabled is off on the instance.",
        });
        return;
      }
      await setActive({ session: sessionId });
      setPhase({ kind: "created", userId: attempt.createdUserId ?? null, sessionId });
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error) });
    }
  }

  async function sendCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const address = email.trim();
    if (!address) {
      setUpgrade({ kind: "error", message: "Enter an email address first." });
      return;
    }
    setUpgrade({ kind: "sending" });
    try {
      const created = (await user.createEmailAddress({ email: address })) as unknown as VerifiableEmail;
      await created.prepareVerification();
      setUpgrade({ kind: "code-sent", email: address });
      setCode("");
    } catch (error) {
      setUpgrade({ kind: "error", message: describeError(error) });
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const address = upgrade.kind === "code-sent" ? upgrade.email : email.trim();
    const target = (user.emailAddresses ?? []).find((entry) => entry.emailAddress === address) as
      | VerifiableEmail
      | undefined;
    if (!target) {
      setUpgrade({ kind: "error", message: "Add the address again; the pending email address is gone." });
      return;
    }
    setUpgrade({ kind: "verifying" });
    try {
      await target.attemptVerification({ code: code.trim() });
      setUpgrade({ kind: "verified", email: address });
      await (instance as unknown as RefreshableInstance).refreshClient?.();
      await readClaim();
    } catch (error) {
      setUpgrade({ kind: "error", message: describeError(error) });
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      await (instance as unknown as RefreshableInstance).refreshClient?.();
      await readClaim();
    } finally {
      setRefreshing(false);
    }
  }

  const session = instance.session;
  const sessionAnonymous = session?.user?.isAnonymous === true;

  return (
    <div className="space-y-8">
      <section aria-labelledby="create-title" className="border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="create-title" className="text-base">
              Create a guest
            </h2>
            <p className="text-xs text-muted-foreground">
              signUp.createAnonymous() posts strategy anonymous and returns a complete sign-up with a session.
            </p>
          </div>
          <StatusChip
            kind={isAnonymous ? "success" : isSignedIn ? "off" : "pending"}
            label={isAnonymous ? "Guest session" : isSignedIn ? "Registered session" : "Signed out"}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button type="button" onClick={() => void createGuest()} disabled={!isLoaded || !signUp || phase.kind === "creating"}>
            {phase.kind === "creating" ? "Creating guest" : "Create a guest session"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Guest sign-up is limited to 10 per hour per address, and needs Guest accounts switched on.
          </span>
        </div>
        {phase.kind === "error" ? (
          <div className="border-t px-4 py-3" role="alert">
            <StatusChip kind="failed" label="Could not create a guest" />
            <p className="mt-1 text-sm text-signal">{phase.message}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Turn on Guest accounts in the dashboard under User and authentication, then try again.
            </p>
          </div>
        ) : phase.kind === "created" ? (
          <div className="border-t px-4 py-3">
            <StatusChip kind="success" label="Guest created" />
            <dl className="mt-2 space-y-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="text-xs text-muted-foreground">User</dt>
                <dd className="font-data text-xs">{phase.userId ?? "not returned"}</dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-2">
                <dt className="text-xs text-muted-foreground">Session</dt>
                <dd className="font-data text-xs">{phase.sessionId}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              Switch it to active with setActive({"{ session }"}), which is what a real app does after sign-up.
            </p>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="state-title" className="border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="state-title" className="text-base">
              What the client and the server say
            </h2>
            <p className="text-xs text-muted-foreground">
              useUser().isAnonymous reads the user resource; the claim comes from the signed session token.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={!isSignedIn || refreshing}>
            <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : undefined} />
            {refreshing ? "Refreshing" : "Refresh"}
          </Button>
        </div>
        <dl className="divide-y">
          <DataRow label="useUser().isAnonymous">
            <StatusChip kind={isAnonymous ? "enabled" : "off"} label={String(isAnonymous)} />
          </DataRow>
          <DataRow label="user.id">
            {user?.id ? <span className="font-data text-xs">{user.id}</span> : <span className="text-muted-foreground">No user loaded</span>}
          </DataRow>
          <DataRow label="Identifiers">
            {user ? (
              <span className="text-xs">
                {user.emailAddresses?.length ?? 0} email, {user.phoneNumbers?.length ?? 0} phone,{" "}
                {user.externalAccounts?.length ?? 0} connected, {user.passwordEnabled ? "password set" : "no password"}
              </span>
            ) : (
              <span className="text-muted-foreground">No user loaded</span>
            )}
          </DataRow>
          <DataRow label={'anonymous claim'}>
            {claim.error ? (
              <span className="text-signal">{claim.error}</span>
            ) : claim.token === null ? (
              <span className="text-muted-foreground">No token yet</span>
            ) : (
              <StatusChip kind={claim.token ? "enabled" : "off"} label={claim.token ? "true" : "absent"} />
            )}
          </DataRow>
          <DataRow label="session.user.isAnonymous">
            <StatusChip kind={sessionAnonymous ? "enabled" : "off"} label={String(sessionAnonymous)} />
          </DataRow>
        </dl>
        <p className="border-t px-4 py-2.5 text-xs text-muted-foreground">
          The claim is derived from the user row on every mint, so a client cannot set it through customClaims.
        </p>
      </section>

      <section aria-labelledby="upgrade-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="upgrade-title" className="text-base">
            Upgrade this guest
          </h2>
          <p className="text-xs text-muted-foreground">
            Adding and verifying an email address keeps the same user, session and metadata. The anonymous claim
            disappears from the next token.
          </p>
        </div>
        {!isSignedIn ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Create a guest above, or <Link href="/sign-in" className="underline underline-offset-4 hover:text-foreground">sign in</Link>{" "}
            to upgrade a real account.
          </p>
        ) : (
          <div className="space-y-4 px-4 py-4">
            <form onSubmit={sendCode} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor="guest-email" className="text-xs font-medium">
                  Email address
                </label>
                <Input
                  id="guest-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="mt-1 h-8"
                  placeholder="ada@example.com"
                  autoComplete="email"
                />
              </div>
              <Button type="submit" size="sm" disabled={upgrade.kind === "sending" || upgrade.kind === "verifying"}>
                {upgrade.kind === "sending" ? "Sending" : "Send code"}
              </Button>
            </form>

            {upgrade.kind === "code-sent" || upgrade.kind === "verifying" ? (
              <form onSubmit={verifyCode} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1">
                  <label htmlFor="guest-code" className="text-xs font-medium">
                    Code sent to {upgrade.kind === "code-sent" ? upgrade.email : email}
                  </label>
                  <Input
                    id="guest-code"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    className="font-data mt-1 h-8"
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                  />
                </div>
                <Button type="submit" size="sm" disabled={!code.trim() || upgrade.kind === "verifying"}>
                  {upgrade.kind === "verifying" ? "Verifying" : "Verify code"}
                </Button>
              </form>
            ) : null}

            {upgrade.kind === "code-sent" ? (
              <p className="text-xs text-muted-foreground">
                {emailTransport
                  ? `The code leaves the server through ${emailTransport}. Check the delivery destination you configured.`
                  : "The code is delivered by the instance mail settings. With the console transport it is printed to the server log."}
              </p>
            ) : null}

            {upgrade.kind === "verified" ? (
              <div role="status" className="border border-go/35 bg-go/5 px-3 py-2">
                <StatusChip kind="success" label="Email verified" />
                <p className="mt-1 text-sm">
                  {upgrade.email} is verified. The account is registered now: isAnonymous is false and the next token
                  has no anonymous claim.
                </p>
              </div>
            ) : null}

            {upgrade.kind === "error" ? (
              <div role="alert" className="border border-signal/40 bg-signal/5 px-3 py-2">
                <StatusChip kind="failed" label="Upgrade failed" />
                <p className="mt-1 text-sm text-signal">{upgrade.message}</p>
              </div>
            ) : null}

            <div className="border-t pt-3">
              <p className="text-xs leading-5 text-muted-foreground">
                Other upgrade paths: verify a phone number, set a password through the account page, or connect an
                external account. Unverified identifiers and profile fields leave a guest a guest.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <Link href="/account">Open the account page</Link>
                </Button>
                {user?.id ? <CopyButton value={user.id} label="Copy user ID" /> : null}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
