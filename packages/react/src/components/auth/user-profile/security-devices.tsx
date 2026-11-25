import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@orbitid/ui";
import { invokeMethod } from "../_shared/api";
import { normalizeSession } from "../_shared/normalize";
import { useReverification } from "../../../hooks";
import { useAuthRuntime } from "../_shared/w6";
import type { NormalizedSession } from "../_shared/w6";
import type { TrustedDeviceResource } from "../../../provider/types";
import { SectionHeader, formatDate, type SectionProps, ProfileSection } from "./security-shared";
import { usePortalClass } from "../_shared/appearance";

export function TrustedDevicesSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t, environment } = runtime;
  const [devices, setDevices] = useState<TrustedDeviceResource[]>([]);
  const [busy, setBusy] = useState(false);
  const enabled = environment.trustedDevices.enabled;

  const load = async () => {
    try {
      const listDevices = user.getTrustedDevices as (() => Promise<TrustedDeviceResource[]>) | undefined;
      if (typeof listDevices !== "function") return setDevices([]);
      const list = await listDevices.call(user);
      setDevices(Array.isArray(list) ? list : []);
    } catch (caught) {
      onError(caught);
    }
  };

  useEffect(() => {
    if (enabled) void load();
  }, [user, enabled]);

  const revoke = async (deviceId: string) => {
    setBusy(true);
    try {
      const revokeDevice = user.revokeTrustedDevice as ((id: string) => Promise<void>) | undefined;
      if (typeof revokeDevice !== "function") throw new Error(t("common.internalError"));
      await revokeDevice.call(user, deviceId);
      await load();
      await refresh();
      onNotice(t("userProfile.trustedDevices.revoked"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  if (!enabled) return null;

  return (
    <ProfileSection id="trusted-devices" className="flex flex-col gap-3">
      <SectionHeader title={t("userProfile.trustedDevices.title")} description={t("userProfile.trustedDevices.description")} />
      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("userProfile.trustedDevices.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {devices.map((device) => {
            const expiresAt = device.expiresAt ?? device.expires_at ?? null;
            const lastUsedAt = device.lastUsedAt ?? device.last_used_at ?? null;
            return (
              <li key={device.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{device.label ?? t("userProfile.devices.unknownDevice")}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {lastUsedAt
                      ? t("userProfile.trustedDevices.lastUsed", { date: formatDate(lastUsedAt) })
                      : t("userProfile.trustedDevices.neverUsed")}
                    {expiresAt ? ` · ${t("userProfile.trustedDevices.expires", { date: formatDate(expiresAt) })}` : ""}
                  </p>
                </div>
                <Button type="button" variant="link" size="sm" className="h-auto min-h-6 px-0 py-1" disabled={busy} onClick={() => void revoke(device.id)}>
                  {t("userProfile.trustedDevices.revoke")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </ProfileSection>
  );
}

export function DevicesSection({ user, refresh, onError, onNotice }: SectionProps) {
  const runtime = useAuthRuntime();
  const { t } = runtime;
  const [sessions, setSessions] = useState<NormalizedSession[]>([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const list = user.getSessions ? await user.getSessions() : runtime.client?.sessions ?? [];
      const currentId = runtime.session?.id ?? runtime.client?.last_active_session_id;
      const normalized = list
        .map((session) => normalizeSession(session))
        .filter((session): session is NormalizedSession => session !== null);
      setSessions(normalized.filter((session) => session.id !== currentId && session.status === "active"));
    } catch (caught) {
      onError(caught);
    }
  };

  useEffect(() => {
    void load();
  }, [user]);

  const revoke = async (sessionId: string) => {
    setBusy(true);
    try {
      if (user.revokeSession) {
        await user.revokeSession(sessionId);
      } else {
        const session = runtime.client?.sessions?.find((candidate) => candidate.id === sessionId);
        if (session) {
          await invokeMethod(session, ["revoke", "remove", "end"]);
        } else {
          throw new Error(t("common.internalError"));
        }
      }
      await load();
      await refresh();
      onNotice(t("userProfile.devices.revoked"));
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  const revokeAll = async () => {
    setBusy(true);
    try {
      for (const session of sessions) await revoke(session.id);
      onNotice(t("userProfile.devices.revokedAll"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProfileSection id="devices" className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader title={t("userProfile.devices.title")} description={t("userProfile.devices.description")} />
        {sessions.length > 0 ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void revokeAll()}>
            {t("userProfile.devices.revokeAll")}
          </Button>
        ) : null}
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("userProfile.devices.none")}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {sessions.map((session) => {
            const activity = session.latest_activity ?? null;
            return (
              <li key={session.id} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">
                    {[activity?.browser_name, activity?.device_type].filter(Boolean).join(" · ") || t("userProfile.devices.unknownDevice")}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[activity?.city, activity?.country].filter(Boolean).join(", ") || t("userProfile.devices.unknownLocation")}
                    {" · "}
                    {t("userProfile.devices.lastActive", { date: formatDate(session.last_active_at) })}
                  </p>
                </div>
                <Button type="button" variant="link" size="sm" className="h-auto min-h-6 px-0 py-1" disabled={busy} onClick={() => void revoke(session.id)}>
                  {t("userProfile.devices.revoke")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </ProfileSection>
  );
}

export function DeleteAccountSection({ user, onError, onDeleted }: SectionProps & { onDeleted: () => void }) {
  const portalClass = usePortalClass();
  const runtime = useAuthRuntime();
  const { t, environment, navigate } = runtime;
  const withVerification = useReverification(async (action: () => Promise<unknown>) => action());
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const confirmWord = t("userProfile.deleteAccount.confirmWord");
  const disabled = !environment.actions.deleteSelf || user.delete_self_enabled === false;

  // A phrase typed in an earlier, cancelled attempt must not leave the destructive button armed on reopen.
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setConfirmation("");
  };

  const remove = async () => {
    setBusy(true);
    try {
      if (!user.delete) throw new Error(t("common.internalError"));
      await withVerification(() => user.delete?.() ?? Promise.resolve());
      changeOpen(false);
      onDeleted();
      navigate(environment.app.homeUrl);
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ProfileSection id="delete-account" className="flex flex-col gap-3 rounded-md border border-destructive/30 p-3">
      <SectionHeader title={t("userProfile.deleteAccount.title")} description={t("userProfile.deleteAccount.description")} />
      {disabled ? (
        <p className="text-xs text-muted-foreground">{t("userProfile.deleteAccount.disabled")}</p>
      ) : (
        <Button type="button" variant="destructive" size="sm" className="w-fit" onClick={() => setOpen(true)}>
          {t("userProfile.deleteAccount.action")}
        </Button>
      )}
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className={portalClass("max-w-md")}>
          <DialogHeader>
            <DialogTitle>{t("userProfile.deleteAccount.confirmTitle")}</DialogTitle>
            <DialogDescription>{t("userProfile.deleteAccount.confirmSubtitle")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirmation">{t("userProfile.deleteAccount.confirmHint")}</Label>
            <Input
              id="delete-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={confirmWord}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => changeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy || confirmation !== confirmWord}
              onClick={() => void remove()}
            >
              {t("userProfile.deleteAccount.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ProfileSection>
  );
}
