import { useState, type FormEvent } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
} from "@orbitid/ui";
import { Ban, KeyRound, Lock, LogOut, RotateCcw, ShieldCheck, ShieldOff, Unlock } from "lucide-react";
import { toast } from "sonner";
import type { UserJSON } from "@orbitid/shared";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useUserAdmin } from "../../lib/user-admin";
import { formatDateTime } from "../../lib/format";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { Panel, Section } from "../shared/section";
import { StatusBadge } from "../shared/status-badge";

export function UserSecurityTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const admin = useUserAdmin(user.id);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [skipChecks, setSkipChecks] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [confirmRemovePassword, setConfirmRemovePassword] = useState(false);
  const [confirmResetMfa, setConfirmResetMfa] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password) return;
    setSavingPassword(true);
    try {
      await api("PATCH", `/users/${user.id}`, {
        password,
        ...(skipChecks ? { skip_password_checks: true } : {}),
      });
      toast.success(user.password_enabled ? "Password updated" : "Password set");
      setPasswordOpen(false);
      setPassword("");
      setSkipChecks(false);
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSavingPassword(false);
    }
  }

  async function removePassword() {
    try {
      await api("PATCH", `/users/${user.id}`, { password: null });
      toast.success("Password removed");
      setConfirmRemovePassword(false);
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

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
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={() => setPasswordOpen(true)}>
              {user.password_enabled ? "Change password" : "Set password"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!user.password_enabled}
              onClick={() => setConfirmRemovePassword(true)}
            >
              Remove password
            </Button>
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Removing the password leaves the user with the remaining sign-in factors.
          </p>
        </Panel>

        <Panel className="p-4">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
            Multi-factor authentication
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            TOTP authenticator and single-use backup codes.
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
              <span className="text-sm">Backup codes</span>
              <StatusBadge
                status={user.backup_code_enabled ? "enabled" : "unverified"}
                label={user.backup_code_enabled ? "Codes available" : "No codes"}
              />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmResetMfa(true)}
              disabled={!user.totp_enabled && !user.backup_code_enabled}
            >
              <RotateCcw aria-hidden /> Reset MFA
            </Button>
            {user.passkeys.length ? (
              <Badge variant="outline">
                {user.passkeys.length} {user.passkeys.length === 1 ? "passkey" : "passkeys"}
              </Badge>
            ) : null}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Resetting removes the authenticator secret and every backup code. The user must enroll again.
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

      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{user.password_enabled ? "Change password" : "Set password"}</DialogTitle>
            <DialogDescription>The password is hashed with argon2id and never returned by the API.</DialogDescription>
          </DialogHeader>
          <form onSubmit={submitPassword} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="set-password">New password</Label>
              <Input
                id="set-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <Label htmlFor="skip-password-checks">Skip policy checks</Label>
                <p className="text-xs text-muted-foreground">Bypass length, complexity and pwned-password validation.</p>
              </div>
              <Switch id="skip-password-checks" checked={skipChecks} onCheckedChange={setSkipChecks} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPasswordOpen(false)} disabled={savingPassword}>
                Cancel
              </Button>
              <Button type="submit" disabled={!password || savingPassword}>
                Save password
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRemovePassword}
        onOpenChange={setConfirmRemovePassword}
        title="Remove password?"
        description="The user will only be able to sign in with another identifier or factor."
        confirmLabel="Remove password"
        destructive
        onConfirm={() => void removePassword()}
      />
      <ConfirmDialog
        open={confirmResetMfa}
        onOpenChange={setConfirmResetMfa}
        title="Reset multi-factor authentication?"
        description="The authenticator secret and all backup codes will be deleted. The user must enroll again."
        confirmLabel="Reset MFA"
        destructive
        pending={admin.pending === "reset-mfa"}
        onConfirm={() =>
          void admin.resetMfa().then((result) => {
            if (result !== undefined) {
              setConfirmResetMfa(false);
              onUpdated();
            }
          })
        }
      />
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
