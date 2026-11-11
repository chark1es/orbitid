import { useState } from "react";
import { Button } from "@orbitid/ui";
import { Ban, KeyRound, Lock, LogOut, ShieldCheck, ShieldOff, Unlock } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { useInstance } from "../../lib/instance";
import { useUserAdmin } from "../../lib/user-admin";
import { formatDateTime } from "../../lib/format";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Panel, Section } from "../shared/section";
import { LabelChip, StatusBadge } from "../shared/status-badge";

export function UserSecurityTab({ user }: { user: UserJSON; onUpdated: () => void }) {
  const admin = useUserAdmin(user.id);
  const instance = useInstance();
  const emailSecondFactor = instance.data?.attributes?.emailAddress?.usedForSecondFactor === true;
  const trustedDevicesEnabled = instance.data?.session?.trustedDevicesEnabled;
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  return (
    <Section
      title="Security"
      description="Passwords, sign-in factors, account locks and failed verification attempts."
      className="border-t-0 pt-0"
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4 text-muted-foreground" aria-hidden />
            Password
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Password sign-in for this account.</p>
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm">Status</span>
              <StatusBadge
                status={user.password_enabled ? "enabled" : "unverified"}
                label={user.password_enabled ? "Password set" : "No password"}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm">Last sign-in</span>
              <span className="font-data text-xs text-muted-foreground">
                {user.last_sign_in_at ? formatDateTime(user.last_sign_in_at) : "Never"}
              </span>
            </div>
          </div>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Password changes and recovery must be completed by the user through the sign-in or account settings flow.
          </p>
        </Panel>

        <Panel className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            Multi-factor authentication
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {emailSecondFactor
              ? "Authenticator app, email codes and single-use backup codes."
              : "TOTP authenticator and single-use backup codes."}
          </p>
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm">Authenticator app</span>
              <StatusBadge
                status={user.totp_enabled ? "enabled" : "unverified"}
                label={user.totp_enabled ? "TOTP enabled" : "Not enabled"}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm">Email code</span>
              <StatusBadge
                status={emailSecondFactor ? "enabled" : "unverified"}
                label={emailSecondFactor ? "Offered as a second factor" : "Not offered"}
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm">Backup codes</span>
              <StatusBadge
                status={user.backup_code_enabled ? "enabled" : "unverified"}
                label={user.backup_code_enabled ? "Codes available" : "No codes"}
              />
            </div>
          </div>
          {emailSecondFactor ? (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Email codes are sent to the user&rsquo;s verified address and never offered when the first factor was
              already an email code or link.
            </p>
          ) : null}
          {trustedDevicesEnabled === false ? (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Trusted devices are off on this instance. Turn them on under Sessions to let a browser skip the second
              factor.
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {user.passkeys.length ? (
              <LabelChip>
                {user.passkeys.length} {user.passkeys.length === 1 ? "passkey" : "passkeys"}
              </LabelChip>
            ) : null}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Only the user can change their authenticator and backup codes after verifying their identity.
          </p>
        </Panel>

        <Panel className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Lock className="size-4 text-muted-foreground" aria-hidden />
            Account state
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Banned users cannot start sessions. Locked users fail verification.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusBadge status={user.banned ? "banned" : "active"} label={user.banned ? "Banned" : "Not banned"} />
            <StatusBadge status={user.locked ? "locked" : "active"} label={user.locked ? "Locked" : "Not locked"} />
            {user.lockout_expires_in_seconds ? (
              <span className="font-data text-xs text-muted-foreground">
                Lock expires in {Math.ceil(user.lockout_expires_in_seconds / 60)} min
              </span>
            ) : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {user.banned ? (
              <Button size="sm" variant="outline" onClick={() => void admin.unban()} disabled={admin.pending === "unban"}>
                <Unlock aria-hidden /> Unban
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void admin.ban()} disabled={admin.pending === "ban"}>
                <Ban aria-hidden /> Ban user
              </Button>
            )}
            {user.locked ? (
              <Button size="sm" variant="outline" onClick={() => void admin.unlock()} disabled={admin.pending === "unlock"}>
                <Unlock aria-hidden /> Unlock
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => void admin.lock()} disabled={admin.pending === "lock"}>
                <Lock aria-hidden /> Lock user
              </Button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="max-w-[36ch] text-xs leading-5 text-muted-foreground">
              Signing out everywhere revokes every active session for this user.
            </p>
            <Button size="sm" variant="outline" onClick={() => setConfirmRevoke(true)}>
              <LogOut aria-hidden /> Sign out everywhere
            </Button>
          </div>
        </Panel>

        <Panel className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldOff className="size-4 text-muted-foreground" aria-hidden />
            Verification attempts
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Failed factor attempts before the account locks.
          </p>
          <div className="mt-3">
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm text-muted-foreground">Remaining attempts</span>
              <span className="font-data text-xs">{user.verification_attempts_remaining ?? "None"}</span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border py-2">
              <span className="text-sm text-muted-foreground">Two-factor enabled</span>
              <StatusBadge status={user.two_factor_enabled ? "enabled" : "unverified"} />
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
              <span className="text-sm text-muted-foreground">External ID</span>
              <code className="max-w-[60%] truncate font-data text-xs">{user.external_id ?? "Not set"}</code>
            </div>
          </div>
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmRevoke}
        onOpenChange={setConfirmRevoke}
        title="Sign the user out of every device?"
        description="All active sessions are revoked immediately."
        confirmLabel="Revoke sessions"
        pending={admin.pending === "revoke-sessions"}
        onConfirm={() =>
          void admin.revokeSessions().then((result) => {
            if (result !== undefined) setConfirmRevoke(false);
          })
        }
      />
    </Section>
  );
}
