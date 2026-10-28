import { useState } from "react";
import type { M2MMachineJSON, M2MTokenJSON, PaginatedList } from "@orbitid/shared";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orbitid/ui";
import { Cpu, Pencil, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "../lib/api";
import { oneTimeSecret, unwrapList } from "./_config/data";
import { errorMessage, formatDate, formatJson, parseJsonRecord } from "./_config/settings";
import {
  CheckboxRow,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorAlert,
  Field,
  JsonEditor,
  PageHeader,
  SectionCard,
  SecretReveal,
  StatusBadge,
  TableSkeleton,
} from "./_config/ui";

interface MachineForm {
  id?: string;
  name: string;
  ttl: string;
  scopedMachines: string[];
}
interface MintForm {
  machineId: string;
  ttl: string;
  claimsText: string;
}

const EMPTY_MACHINE: MachineForm = { name: "", ttl: "3600", scopedMachines: [] };
const EMPTY_MINT: MintForm = { machineId: "", ttl: "3600", claimsText: formatJson({}) };

export default function Page() {
  const machinesQuery = useApi<PaginatedList<M2MMachineJSON>>(["m2m-machines"], "/m2m/machines?limit=100");
  const tokensQuery = useApi<PaginatedList<M2MTokenJSON>>(["m2m-tokens"], "/m2m/tokens?limit=100");
  const machines = unwrapList<M2MMachineJSON>(machinesQuery.data);
  const tokens = unwrapList<M2MTokenJSON>(tokensQuery.data);

  const [machineDialog, setMachineDialog] = useState(false);
  const [machineForm, setMachineForm] = useState<MachineForm>(EMPTY_MACHINE);
  const [machineSaving, setMachineSaving] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string | null } | null>(null);
  const [rotating, setRotating] = useState<M2MMachineJSON | null>(null);
  const [rotatingBusy, setRotatingBusy] = useState(false);
  const [mintDialog, setMintDialog] = useState(false);
  const [mint, setMint] = useState<MintForm>(EMPTY_MINT);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<M2MTokenJSON | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? id;

  const openCreate = () => {
    setMachineForm(EMPTY_MACHINE);
    setMachineDialog(true);
  };
  const openEdit = (machine: M2MMachineJSON) => {
    setMachineForm({
      id: machine.id,
      name: machine.name,
      ttl: String(machine.default_token_ttl),
      scopedMachines: machine.scoped_machines ?? [],
    });
    setMachineDialog(true);
  };

  const machineErrors: string[] = [];
  if (!machineForm.name.trim()) machineErrors.push("Machine name is required.");
  const ttl = Number(machineForm.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) machineErrors.push("Default token TTL must be a positive number of seconds.");

  const saveMachine = async () => {
    if (machineErrors.length > 0) return;
    setMachineSaving(true);
    try {
      const body = { name: machineForm.name.trim(), default_token_ttl: ttl, scoped_machines: machineForm.scopedMachines };
      const response = await api<unknown>(machineForm.id ? "PATCH" : "POST", machineForm.id ? `/m2m/machines/${machineForm.id}` : "/m2m/machines", body);
      await machinesQuery.refetch();
      setMachineDialog(false);
      if (!machineForm.id) {
        setSecret({ title: `Machine “${body.name}” created`, value: oneTimeSecret(response) });
        toast.success("Machine created");
      } else {
        toast.success("Machine updated");
      }
    } catch (error) {
      toast.error("Could not save machine", { description: errorMessage(error) });
    } finally {
      setMachineSaving(false);
    }
  };

  const rotateSecret = async () => {
    if (!rotating) return;
    setRotatingBusy(true);
    try {
      const response = await api<unknown>("POST", `/m2m/machines/${rotating.id}/secret/rotate`);
      setSecret({ title: `Secret rotated for “${rotating.name}”`, value: oneTimeSecret(response) });
      setRotating(null);
      await machinesQuery.refetch();
      toast.success("Machine secret rotated");
    } catch (error) {
      toast.error("Could not rotate secret", { description: errorMessage(error) });
    } finally {
      setRotatingBusy(false);
    }
  };

  const mintErrors: string[] = [];
  if (!mint.machineId) mintErrors.push("Choose a machine.");
  const mintTtl = Number(mint.ttl);
  if (!Number.isFinite(mintTtl) || mintTtl <= 0) mintErrors.push("TTL must be a positive number of seconds.");
  const claimsParsed = parseJsonRecord(mint.claimsText);
  if (claimsParsed.error) mintErrors.push(`Claims: ${claimsParsed.error}`);

  const mintToken = async () => {
    if (!claimsParsed.value || mintErrors.length > 0) return;
    setMinting(true);
    setMintedToken(null);
    try {
      const response = await api<unknown>("POST", "/m2m/tokens", {
        machine_id: mint.machineId,
        seconds_until_expiration: mintTtl,
        claims: claimsParsed.value,
      });
      setMintedToken(oneTimeSecret(response) ?? (typeof response === "string" ? response : null));
      await tokensQuery.refetch();
      toast.success("Token minted");
    } catch (error) {
      toast.error("Could not mint token", { description: errorMessage(error) });
    } finally {
      setMinting(false);
    }
  };

  const revokeToken = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await api("POST", `/m2m/tokens/${revoking.id}/revoke`);
      await tokensQuery.refetch();
      toast.success("Token revoked");
      setRevoking(null);
    } catch (error) {
      toast.error("Could not revoke token", { description: errorMessage(error) });
    } finally {
      setRevokeBusy(false);
    }
  };

  const toggleScopedMachine = (id: string, checked: boolean) => {
    setMachineForm((current) => ({
      ...current,
      scopedMachines: checked ? [...current.scopedMachines, id] : current.scopedMachines.filter((value) => value !== id),
    }));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Machine-to-machine"
        description="Machines authenticate as themselves, optionally scoped to other machines, and mint short-lived tokens."
        badge={<Badge variant="outline">{machines.length} machines</Badge>}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setMint(EMPTY_MINT); setMintedToken(null); setMintDialog(true); }}>
              Mint test token
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" /> Create machine
            </Button>
          </div>
        }
      />

      <SectionCard title="Machines" description="Machine secrets are shown once. Scoped machines may exchange machine identity for downstream tokens.">
        {machinesQuery.error ? (
          <ErrorAlert error={errorMessage(machinesQuery.error)} onRetry={() => void machinesQuery.refetch()} />
        ) : machinesQuery.isLoading ? (
          <TableSkeleton />
        ) : machines.length === 0 ? (
          <EmptyState
            title="No machines"
            description="Create a machine for a service that needs to authenticate without a user session."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" /> Create machine
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  <TableHead>Scoped machines</TableHead>
                  <TableHead>Default TTL</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-28" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {machines.map((machine) => (
                  <TableRow key={machine.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Cpu className="size-4 text-muted-foreground" />
                        <span className="font-medium">{machine.name}</span>
                      </div>
                      <code className="text-xs text-muted-foreground">{machine.id}</code>
                    </TableCell>
                    <TableCell>
                      {(machine.scoped_machines ?? []).length === 0 ? (
                        <span className="text-xs text-muted-foreground">None</span>
                      ) : (
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {machine.scoped_machines.map((id) => (
                            <Badge key={id} variant="secondary">
                              {machineName(id)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{machine.default_token_ttl}s</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(machine.created_at)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => setRotating(machine)} title="Rotate secret">
                          <RotateCw className="size-4" />
                          <span className="sr-only">Rotate secret</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(machine)} title="Edit">
                          <Pencil className="size-4" />
                          <span className="sr-only">Edit</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Tokens"
        description="Issued machine tokens. Revoking a token immediately invalidates it."
        actions={
          <Button variant="ghost" size="icon-sm" onClick={() => void tokensQuery.refetch()} title="Refresh">
            <RefreshCw className="size-4" />
            <span className="sr-only">Refresh</span>
          </Button>
        }
      >
        {tokensQuery.error ? (
          <ErrorAlert error={errorMessage(tokensQuery.error)} onRetry={() => void tokensQuery.refetch()} />
        ) : tokensQuery.isLoading ? (
          <TableSkeleton />
        ) : tokens.length === 0 ? (
          <EmptyState title="No tokens" description="Mint a test token or let a machine request one at runtime." />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Machine</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Claims</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>{machineName(token.machine_id)}</TableCell>
                    <TableCell>
                      <StatusBadge status={token.revoked ? "revoked" : token.expired ? "expired" : "active"} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(token.expiration)}</TableCell>
                    <TableCell>
                      {token.claims && Object.keys(token.claims).length > 0 ? (
                        <code className="text-xs">{formatJson(token.claims)}</code>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(token.created_at)}</TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive"
                        disabled={token.revoked}
                        onClick={() => setRevoking(token)}
                        title="Revoke"
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Revoke</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <Dialog open={machineDialog} onOpenChange={setMachineDialog}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{machineForm.id ? "Edit machine" : "Create machine"}</DialogTitle>
            <DialogDescription>Machines use their secret to request tokens from `/v1/m2m/tokens`.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Name" htmlFor="machine-name" required>
              <Input id="machine-name" value={machineForm.name} onChange={(event) => setMachineForm((current) => ({ ...current, name: event.target.value }))} placeholder="billing-worker" />
            </Field>
            <Field label="Default token TTL (seconds)" htmlFor="machine-ttl">
              <Input
                id="machine-ttl"
                type="number"
                min={1}
                value={machineForm.ttl}
                onChange={(event) => setMachineForm((current) => ({ ...current, ttl: event.target.value }))}
              />
            </Field>
            <Field label="Scoped machines" description="Allow this machine to act on behalf of selected machines.">
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border p-2">
                {machines.filter((machine) => machine.id !== machineForm.id).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No other machines available.</p>
                ) : (
                  machines
                    .filter((machine) => machine.id !== machineForm.id)
                    .map((machine) => (
                      <CheckboxRow
                        key={machine.id}
                        label={machine.name}
                        checked={machineForm.scopedMachines.includes(machine.id)}
                        onCheckedChange={(checked) => toggleScopedMachine(machine.id, checked)}
                      />
                    ))
                )}
              </div>
            </Field>
            {machineErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {machineErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMachineDialog(false)} disabled={machineSaving}>
              Cancel
            </Button>
            <Button onClick={() => void saveMachine()} disabled={machineSaving || machineErrors.length > 0}>
              {machineSaving ? "Saving…" : machineForm.id ? "Save changes" : "Create machine"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secret !== null} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{secret?.title ?? "Machine secret"}</DialogTitle>
            <DialogDescription>Copy the secret now. Only a hash is stored and it cannot be shown again.</DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertTitle>One-time secret</AlertTitle>
            <AlertDescription>Store it in your deployment's secret manager.</AlertDescription>
          </Alert>
          {secret?.value ? (
            <div className="space-y-2">
              <SecretReveal value={secret.value} />
              <CopyButton value={secret.value} variant="outline" size="sm" label="Copy secret" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">The server did not return a secret. Rotate the machine secret to generate a new one.</p>
          )}
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mintDialog} onOpenChange={setMintDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Mint test token</DialogTitle>
            <DialogDescription>Issue a token directly from the dashboard for local testing.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Field label="Machine" htmlFor="mint-machine">
              <Select value={mint.machineId} onValueChange={(machineId) => setMint((current) => ({ ...current, machineId }))}>
                <SelectTrigger id="mint-machine" className="w-full">
                  <SelectValue placeholder="Choose a machine" />
                </SelectTrigger>
                <SelectContent>
                  {machines.map((machine) => (
                    <SelectItem key={machine.id} value={machine.id}>
                      {machine.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="TTL (seconds)" htmlFor="mint-ttl">
              <Input id="mint-ttl" type="number" min={1} value={mint.ttl} onChange={(event) => setMint((current) => ({ ...current, ttl: event.target.value }))} />
            </Field>
            <Field label="Claims (JSON)">
              <JsonEditor
                value={mint.claimsText}
                onChange={(claimsText) => setMint((current) => ({ ...current, claimsText }))}
                error={claimsParsed.error}
                rows={6}
              />
            </Field>
            {mintedToken ? (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm font-medium">Token</p>
                <SecretReveal value={mintedToken} />
                <CopyButton value={mintedToken} variant="outline" size="sm" label="Copy token" />
              </div>
            ) : null}
            {mintErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {mintErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMintDialog(false)} disabled={minting}>
              Close
            </Button>
            <Button onClick={() => void mintToken()} disabled={minting || mintErrors.length > 0}>
              {minting ? "Minting…" : "Mint token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => !open && setRotating(null)}
        title="Rotate machine secret?"
        description={
          <span>
            The existing secret for <strong>{rotating?.name}</strong> stops working immediately.
          </span>
        }
        confirmLabel="Rotate secret"
        destructive
        loading={rotatingBusy}
        onConfirm={() => void rotateSecret()}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title="Revoke token?"
        description="The token will be rejected by verification endpoints immediately."
        confirmLabel="Revoke token"
        destructive
        loading={revokeBusy}
        onConfirm={() => void revokeToken()}
      />
    </div>
  );
}
