"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@orbitid/ui";
import { useAuth, useUser } from "@orbitid/react";
import type { TrustedDeviceResource } from "@orbitid/react";
import { StatusChip } from "../status-chip";
import { formatDateTime } from "@/lib/format";
import { useSkipMarker } from "./shared";

export function TrustedDevicesSection() {
  const { user } = useUser();
  const { isSignedIn, sessionId } = useAuth();
  const skip = useSkipMarker(sessionId, isSignedIn);
  const [devices, setDevices] = React.useState<TrustedDeviceResource[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [revoking, setRevoking] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!user?.getTrustedDevices) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setDevices(await user.getTrustedDevices());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The trusted-device request failed.");
    } finally {
      setLoading(false);
    }
  }, [user]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function revoke(deviceId: string) {
    if (!user?.revokeTrustedDevice) return;
    setRevoking(deviceId);
    try {
      await user.revokeTrustedDevice(deviceId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The device could not be revoked.");
    } finally {
      setRevoking(null);
    }
  }

  const skipped = skip.marker === "skipped";

  return (
    <section aria-labelledby="trusted-devices-title" className="border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 id="trusted-devices-title" className="text-base">
            Trusted devices
          </h2>
          <p className="text-xs text-muted-foreground">
            Browsers remembered for skipping the second factor. The token is an HttpOnly cookie, so it is never shown
            here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusChip kind={skipped ? "needs-config" : "off"} label={skipped ? "This session skipped the second factor" : "No skip on this session"} />
          <Button type="button" variant="outline" size="xs" onClick={() => void load()} disabled={!isSignedIn || loading}>
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />
            Reload
          </Button>
        </div>
      </div>

      {!isSignedIn ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          Sign in to list the browsers remembered for this account.
        </p>
      ) : error ? (
        <div role="alert" className="px-4 py-4">
          <StatusChip kind="failed" label="Could not read trusted devices" />
          <p className="mt-1 text-sm text-signal">{error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The list needs the trusted devices feature to be on. Turn it on under Sessions in the dashboard.
          </p>
        </div>
      ) : loading && !devices ? (
        <div className="space-y-2 px-4 py-3" aria-busy="true">
          <div className="h-3 w-40 animate-pulse rounded-sm bg-muted" />
          <div className="h-10 w-full animate-pulse rounded-sm bg-muted/70" />
        </div>
      ) : !devices || devices.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No trusted devices. Tick “Trust this browser” on a second-factor sign-in to create one.
        </p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Trusted devices for the signed-in user</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Device
              </th>
              <th scope="col" className="hidden px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase sm:table-cell">
                Address
              </th>
              <th scope="col" className="hidden px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase md:table-cell">
                Last used
              </th>
              <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Expires
              </th>
              <th scope="col" className="w-10 px-4 py-2 text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {devices.map((device) => (
              <tr key={device.id}>
                <td className="px-4 py-2">
                  <p className="text-sm">{device.label ?? "Trusted browser"}</p>
                  <span className="font-data text-[0.6875rem] text-muted-foreground">{device.id}</span>
                </td>
                <td className="font-data hidden px-4 py-2 text-xs text-muted-foreground sm:table-cell">
                  {device.ipAddress ?? "Unknown"}
                </td>
                <td className="font-data hidden px-4 py-2 text-xs text-muted-foreground md:table-cell">
                  {device.lastUsedAt ? formatDateTime(device.lastUsedAt) : "Never used"}
                </td>
                <td className="font-data px-4 py-2 text-xs text-muted-foreground">
                  {device.expiresAt ? formatDateTime(device.expiresAt) : "Unknown"}
                </td>
                <td className="px-4 py-2 text-right">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={revoking !== null}
                    onClick={() => void revoke(device.id)}
                  >
                    {revoking === device.id ? "Revoking" : "Revoke"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
