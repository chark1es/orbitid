import { useEffect, useState } from "react";
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import {
  CheckboxRow,
  CopyButton,
  DetailSheet,
  Field,
  JsonEditor,
  SecretReveal,
  ValidationSummary,
} from "../_config/ui";
import type { M2MController } from "./use-m2m";

export function MachineSheet({ ctl }: { ctl: M2MController }) {
  const {
    machineOpen,
    setMachineOpen,
    machineForm,
    setMachineForm,
    machineSaving,
    machines,
    machineErrors,
    saveMachine,
    toggleScopedMachine,
  } = ctl;
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!machineOpen) setAttempted(false);
  }, [machineOpen]);

  return (
    <DetailSheet
      open={machineOpen}
      onOpenChange={setMachineOpen}
      title={machineForm.id ? "Edit machine" : "Create machine"}
      description="Machines use their secret to request tokens from /v1/m2m/tokens."
      footer={
        <>
          <Button variant="outline" onClick={() => setMachineOpen(false)} disabled={machineSaving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setAttempted(true);
              if (machineErrors.length === 0) void saveMachine();
            }}
            disabled={machineSaving}
          >
            {machineSaving ? "Saving…" : machineForm.id ? "Save changes" : "Create machine"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" htmlFor="machine-name" required>
          <Input
            id="machine-name"
            value={machineForm.name}
            onChange={(event) => setMachineForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="reporting-worker"
          />
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
        <Field label="Scoped machines" description="Allow this machine to act on behalf of the selected machines.">
          <div className="max-h-48 space-y-1 overflow-y-auto border border-border p-2">
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
        <ValidationSummary errors={attempted ? machineErrors : []} title="Fix this before saving" />
      </div>
    </DetailSheet>
  );
}

export function MachineSecretSheet({ ctl }: { ctl: M2MController }) {
  const { secret, setSecret } = ctl;

  return (
    <DetailSheet
      open={secret !== null}
      onOpenChange={(open) => !open && setSecret(null)}
      title={secret?.title ?? "Machine secret"}
      description="Copy the secret now. Only a hash is stored, so it cannot be shown again."
      footer={<Button onClick={() => setSecret(null)}>Done</Button>}
    >
      {secret?.value ? (
        <>
          <SecretReveal
            value={secret.value}
            warning="Store the secret in your deployment's secret manager. Rotating it later invalidates this value immediately."
          />
          <CopyButton value={secret.value} variant="outline" size="sm" label="Copy secret" />
        </>
      ) : (
        <p className="text-sm leading-relaxed text-muted-foreground">
          The server did not return a secret. Rotate the machine secret to generate a new one.
        </p>
      )}
    </DetailSheet>
  );
}

export function MintTokenSheet({ ctl }: { ctl: M2MController }) {
  const {
    mintOpen,
    setMintOpen,
    mint,
    setMint,
    minting,
    mintedToken,
    machines,
    mintErrors,
    claimsParsed,
    mintToken,
  } = ctl;

  return (
    <DetailSheet
      open={mintOpen}
      onOpenChange={setMintOpen}
      title="Mint test token"
      description="Issue a token from the dashboard for local testing."
      footer={
        <>
          <Button variant="outline" onClick={() => setMintOpen(false)} disabled={minting}>
            Close
          </Button>
          <Button onClick={() => void mintToken()} disabled={minting || mintErrors.length > 0}>
            {minting ? "Minting…" : "Mint token"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
          <Input
            id="mint-ttl"
            type="number"
            min={1}
            value={mint.ttl}
            onChange={(event) => setMint((current) => ({ ...current, ttl: event.target.value }))}
          />
        </Field>
        <Field label="Claims (JSON)">
          <JsonEditor
            value={mint.claimsText}
            onChange={(claimsText) => setMint((current) => ({ ...current, claimsText }))}
            error={claimsParsed.error}
            rows={6}
            aria-label="Token claims"
          />
        </Field>
        {mintedToken ? (
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm font-medium">Token</p>
            <SecretReveal value={mintedToken} warning="This token is shown once. Copy it into your test client." />
            <CopyButton value={mintedToken} variant="outline" size="sm" label="Copy token" />
          </div>
        ) : null}
        <ValidationSummary errors={mintErrors} title="Fix this before minting" />
      </div>
    </DetailSheet>
  );
}
