import { Button, Switch, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Building2, Eye, Plus, Trash2 } from "lucide-react";
import { formatDate } from "../_config/settings";
import { EmptyState, RuledTable, StatusBadge, TableSkeleton } from "../_config/ui";
import type { EnterpriseSsoController } from "./use-enterprise-sso";

export function ConnectionsTable({ ctl }: { ctl: EnterpriseSsoController }) {
  const { setDetail, setSelected, query, connections, openWizard, toggleActive } = ctl;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-heading">Connections</h2>
        <p className="text-xs text-muted-foreground">Only active connections take part in domain routing.</p>
      </div>
      {query.isLoading ? (
        <TableSkeleton />
      ) : connections.length === 0 ? (
        <EmptyState
          compact
          title="No enterprise connections"
          description="Connect any SAML 2.0 or OpenID Connect identity provider your organization already uses."
          icon={<Building2 className="size-5" />}
          action={
            <Button size="sm" onClick={openWizard}>
              <Plus className="size-4" aria-hidden /> Connect SSO
            </Button>
          }
        />
      ) : (
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Connection</TableHead>
              <TableHead className="hidden xl:table-cell">Protocol</TableHead>
              <TableHead className="hidden lg:table-cell">Domains</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden xl:table-cell">Created</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow key={connection.id}>
                <TableCell className="text-sm font-medium">
                  <span className="block max-w-[32ch] truncate" title={connection.name}>{connection.name}</span>
                </TableCell>
                <TableCell className="hidden text-xs font-medium xl:table-cell">{connection.protocol}</TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className="block max-w-[22rem] truncate text-xs text-muted-foreground" title={connection.domains.join(", ")}>{connection.domains.join(", ")}</span>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Switch checked={connection.active} onCheckedChange={() => void toggleActive(connection)} aria-label="Connection active" />
                    <StatusBadge status={connection.active ? "active" : "disabled"} />
                  </div>
                </TableCell>
                <TableCell className="hidden font-data text-xs text-muted-foreground xl:table-cell">{formatDate(connection.created_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setDetail(connection)} title="Details">
                      <Eye className="size-4" aria-hidden />
                      <span className="sr-only">Details for {connection.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(connection)} title="Delete">
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete {connection.name}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </RuledTable>
      )}
    </section>
  );
}
