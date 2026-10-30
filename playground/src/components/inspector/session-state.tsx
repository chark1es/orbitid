"use client";

import { useAuth, useSession, useUser } from "@orbitid/react";
import { StatusChip } from "../status-chip";
import { formatDateTime } from "@/lib/format";
import { DataRow, Mono, useSkipMarker } from "./shared";

export function SessionState() {
  const auth = useAuth({ treatPendingAsSignedOut: false });
  const { user, isAnonymous } = useUser();
  const { session } = useSession();
  const permissions = auth.orgPermissions ?? [];
  const skip = useSkipMarker(auth.sessionId, auth.isSignedIn);

  return (
    <section aria-labelledby="state-title" className="border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 id="state-title" className="text-base">
            Auth state
          </h2>
          <p className="text-xs text-muted-foreground">Live values from useAuth, useUser and useSession.</p>
        </div>
        {!auth.isLoaded ? (
          <StatusChip kind="pending" label="Loading" />
        ) : auth.isSignedIn ? (
          <StatusChip kind="success" label="Signed in" />
        ) : (
          <StatusChip kind="off" label="Signed out" />
        )}
      </div>
      <dl className="divide-y">
        <DataRow label="userId">
          {auth.userId ? <Mono>{auth.userId}</Mono> : <span className="text-muted-foreground">null</span>}
        </DataRow>
        <DataRow label="sessionId">
          {auth.sessionId ? <Mono>{auth.sessionId}</Mono> : <span className="text-muted-foreground">null</span>}
        </DataRow>
        <DataRow label="sessionStatus">
          {auth.sessionStatus ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip
                kind={auth.sessionStatus === "pending" ? "pending" : "success"}
                label={auth.sessionStatus}
              />
              {auth.sessionStatus === "pending" ? (
                <span className="text-xs text-muted-foreground">
                  useAuth treats a pending session as signed out unless you pass treatPendingAsSignedOut: false.
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </DataRow>
        <DataRow label="organization">
          {auth.orgId ? (
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{auth.orgSlug ?? auth.orgId}</Mono>
              <span className="text-xs text-muted-foreground">role {auth.orgRole ?? "none"}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">No active organization</span>
          )}
        </DataRow>
        <DataRow label="permissions">
          {permissions.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {permissions.map((permission) => (
                <li key={permission} className="font-data rounded-sm border px-1.5 py-0.5 text-[0.6875rem]">
                  {permission}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None on the active organization</span>
          )}
        </DataRow>
        <DataRow label="user">
          {user ? (
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{user.primaryEmailAddress?.emailAddress ?? user.id}</Mono>
              <span className="text-xs text-muted-foreground">
                {[user.firstName, user.lastName].filter(Boolean).join(" ") || "No name set"}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Not loaded</span>
          )}
        </DataRow>
        <DataRow label="session expires">
          {session?.expireAt ? (
            <Mono>{formatDateTime(session.expireAt)}</Mono>
          ) : (
            <span className="text-muted-foreground">Not reported by the session resource</span>
          )}
        </DataRow>
        <DataRow label="isAnonymous">
          {auth.isSignedIn ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip kind={isAnonymous ? "enabled" : "off"} label={String(isAnonymous)} />
              <span className="text-xs text-muted-foreground">
                {isAnonymous
                  ? "Guest account: no identifier yet. Signing in again is impossible until it gains one."
                  : "The account has at least one way to sign in."}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">No session</span>
          )}
        </DataRow>
        <DataRow label="second factor">
          {skip.marker === "skipped" ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip kind="needs-config" label="Skipped: trusted device" />
              <span className="text-xs text-muted-foreground">
                This session was created without a second factor because the browser held a trusted-device token.
              </span>
            </span>
          ) : skip.marker === "not-skipped" ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip kind="off" label="Not skipped" />
              <span className="text-xs text-muted-foreground">
                The instance reports no trusted-device skip for this session.
              </span>
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip kind="pending" label="Not reported" />
              <span className="text-xs text-muted-foreground">
                {skip.error ?? (auth.isSignedIn ? "The session is not in the list yet." : "No session.")}
              </span>
            </span>
          )}
        </DataRow>
        <DataRow label="isLoaded">
          <Mono>{String(auth.isLoaded)}</Mono>
        </DataRow>
      </dl>
    </section>
  );
}
