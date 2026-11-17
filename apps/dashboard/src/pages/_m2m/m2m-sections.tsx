import { Button, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Pencil, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { errorMessage, formatDate, formatJson } from "../_config/settings";
import { EmptyState, ErrorAlert, RuledTable, StatusBadge, TableSkeleton } from "../_config/ui";
import type { M2MController } from "./use-m2m";

export function MachinesSection({ ctl }: { ctl: M2MController }) {
  const { setRotating, machinesQuery, machines, machineName, openCreate, openEdit } = ctl;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-heading">Machines</h2>
        <p className="text-xs text-muted-foreground">Secrets are shown once. Scoped machines can exchange identity for downstream tokens.</p>
      </div>
      {machinesQuery.error ? (
        <ErrorAlert error={errorMessage(machinesQuery.error)} onRetry={() => void machinesQuery.refetch()} />
      ) : machinesQuery.isLoading ? (
        <TableSkeleton />
      ) : machines.length === 0 ? (
        <EmptyState
          compact
          title="No machines"
          description="Create a machine for a service that authenticates without a user session."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden /> Create machine
            </Button>
          }
        />
      ) : (
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Machine</TableHead>
              <TableHead className="hidden xl:table-cell">Scoped machines</TableHead>
              <TableHead className="text-right">Default TTL</TableHead>
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead className="w-24 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {machines.map((machine) => (
              <TableRow key={machine.id}>
                <TableCell>
                  <div className="flex min-w-0 max-w-[26rem] items-baseline gap-2">
                    <p className="truncate text-sm font-medium" title={machine.name}>
                      {machine.name}
                    </p>
                    <code className="min-w-0 truncate font-data text-xs text-muted-foreground" title={machine.id}>
                      {machine.id}
                    </code>
                  </div>
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  {(machine.scoped_machines ?? []).length === 0 ? (
                    <span className="text-xs text-muted-foreground">None</span>
                  ) : (
                    <span className="block max-w-[18rem] truncate text-xs text-muted-foreground">
                      {machine.scoped_machines.map((id) => machineName(id)).join(", ")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right font-data text-xs">{machine.default_token_ttl}s</TableCell>
                <TableCell className="hidden font-data text-xs text-muted-foreground lg:table-cell">{formatDate(machine.created_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setRotating(machine)} title="Rotate secret">
                      <RotateCw className="size-4" aria-hidden />
                      <span className="sr-only">Rotate secret for {machine.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(machine)} title="Edit">
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit {machine.name}</span>
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

export function TokensSection({ ctl }: { ctl: M2MController }) {
  const { setRevoking, tokensQuery, tokens, machineName } = ctl;

  return (
    <section className="space-y-3 border-t border-border pt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-heading">Tokens</h2>
        <div className="flex items-center gap-3">
          <p className="hidden text-xs text-muted-foreground sm:block">Revoking a token invalidates it immediately.</p>
          <Button variant="ghost" size="icon-sm" onClick={() => void tokensQuery.refetch()} title="Refresh">
            <RefreshCw className="size-4" aria-hidden />
            <span className="sr-only">Refresh tokens</span>
          </Button>
        </div>
      </div>
      {tokensQuery.error ? (
        <ErrorAlert error={errorMessage(tokensQuery.error)} onRetry={() => void tokensQuery.refetch()} />
      ) : tokensQuery.isLoading ? (
        <TableSkeleton />
      ) : tokens.length === 0 ? (
        <EmptyState compact title="No tokens" description="Mint a test token, or let a machine request one at runtime." />
      ) : (
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Machine</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden xl:table-cell">Expires</TableHead>
              <TableHead className="hidden xl:table-cell">Claims</TableHead>
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead className="w-16 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="text-sm">
                  <span className="block max-w-[24ch] truncate" title={machineName(token.machine_id)}>
                    {machineName(token.machine_id)}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={token.revoked ? "revoked" : token.expired ? "expired" : "active"} />
                </TableCell>
                <TableCell className="hidden font-data text-xs text-muted-foreground xl:table-cell">{formatDate(token.expiration)}</TableCell>
                <TableCell className="hidden xl:table-cell">
                  {token.claims && Object.keys(token.claims).length > 0 ? (
                    <code className="block max-w-[20rem] truncate font-data text-xs">{formatJson(token.claims)}</code>
                  ) : (
                    <span className="text-xs text-muted-foreground">None</span>
                  )}
                </TableCell>
                <TableCell className="hidden font-data text-xs text-muted-foreground lg:table-cell">{formatDate(token.created_at)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive"
                    disabled={token.revoked}
                    onClick={() => setRevoking(token)}
                    title="Revoke">
                    <Trash2 className="size-4" aria-hidden />
                    <span className="sr-only">Revoke token</span>
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </RuledTable>
      )}
    </section>
  );
}
