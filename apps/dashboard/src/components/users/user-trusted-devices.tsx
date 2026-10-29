import { useState } from "react";
import { Button } from "@orbitid/ui";
import { LaptopMinimal } from "lucide-react";
import { toast } from "sonner";
import type { TrustedDeviceJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDateTime, formatRelativeTime } from "../../lib/format";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { DataTable, type DataTableColumn } from "../shared/data-table";
import { EmptyState } from "../shared/empty-state";
import { Section } from "../shared/section";

/**
 * The API lists only live devices: expired and revoked rows are filtered out server-side, and the token
 * hash is never serialized. So this table needs no state filter, and every row is still in force.
 */
export function UserTrustedDevices({ userId }: { userId: string }) {
  const devices = useApi<TrustedDeviceJSON[]>(["user-trusted-devices", userId], `/users/${userId}/trusted_devices`);
  const [selected, setSelected] = useState<TrustedDeviceJSON | null>(null);
  const [pending, setPending] = useState(false);

  const rows = devices.data ?? [];

  async function revoke(device: TrustedDeviceJSON) {
    setPending(true);
    try {
      await api("DELETE", `/users/${userId}/trusted_devices/${device.id}`);
      toast.success("Trusted device revoked");
      setSelected(null);
      await devices.refetch();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const columns: DataTableColumn<TrustedDeviceJSON>[] = [
    {
      id: "label",
      header: "Label",
      cell: (device) => (
        <div className="min-w-0">
          <p className="truncate text-sm">{device.label || "Trusted browser"}</p>
          <code className="block max-w-[34ch] truncate font-data text-[0.6875rem] text-muted-foreground">
            {device.id}
          </code>
        </div>
      ),
    },
    {
      id: "ip",
      header: "IP address",
      headerClassName: "hidden sm:table-cell",
      className: "hidden sm:table-cell",
      cell: (device) => (
        <span className="font-data text-xs text-muted-foreground">{device.ip_address || "Unknown IP"}</span>
      ),
    },
    {
      id: "last_used",
      header: "Last used",
      headerClassName: "hidden md:table-cell",
      className: "hidden md:table-cell",
      cell: (device) =>
        device.last_used_at ? (
          <span className="text-xs text-muted-foreground" title={formatDateTime(device.last_used_at)}>
            {formatRelativeTime(device.last_used_at)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Never used</span>
        ),
    },
    {
      id: "expires",
      header: "Expires",
      cell: (device) => (
        <span className="font-data text-xs text-muted-foreground">{formatDateTime(device.expires_at)}</span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-10 text-right",
      headerClassName: "w-10",
      cell: (device) => (
        <Button size="xs" variant="outline" disabled={pending} onClick={() => setSelected(device)}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <Section
      title="Trusted devices"
      description="Browsers that may skip this user's second factor. The server checks the row on every sign-in, so a revocation takes effect immediately."
      className="border-t-0 pt-0"
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(device) => device.id}
        isLoading={devices.isLoading}
        error={devices.error}
        onRetry={() => void devices.refetch()}
        loadingRows={2}
        empty={
          <EmptyState
            icon={LaptopMinimal}
            title="No trusted devices"
            description="A browser appears here after the user ticks “Trust this browser” during a second-factor sign-in. Nothing skips the second factor for this account now."
          />
        }
      />
      <p className="mt-2 max-w-[75ch] text-xs leading-5 text-muted-foreground">
        Expired and revoked devices are not listed. Changing the password, removing a second factor, banning or locking
        the user revokes every device on this list.
      </p>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={`Revoke ${selected?.label || "this trusted browser"}?`}
        description="The browser must complete the second factor on its next sign-in."
        confirmLabel="Revoke device"
        destructive
        pending={pending}
        onConfirm={() => {
          if (selected) void revoke(selected);
        }}
      />
    </Section>
  );
}
