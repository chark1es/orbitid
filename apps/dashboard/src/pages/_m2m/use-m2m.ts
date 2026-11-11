import { useState } from "react";
import type { M2MMachineJSON, M2MTokenJSON, PaginatedList } from "@orbitid/shared";
import { toast } from "sonner";
import { api, apiAllPages, useApi } from "../../lib/api";
import { oneTimeSecret, unwrapList } from "../_config/data";
import { errorMessage, parseJsonRecord } from "../_config/settings";
import { type MachineForm, type MintForm, EMPTY_MACHINE, EMPTY_MINT } from "./model";

export function useM2M() {
  const machinesQuery = useApi<PaginatedList<M2MMachineJSON>>(["m2m-machines"], "/m2m/machines", {
    queryFn: ({ signal }) => apiAllPages<M2MMachineJSON>("/m2m/machines", { signal }),
  });
  const tokensQuery = useApi<PaginatedList<M2MTokenJSON>>(["m2m-tokens"], "/m2m/tokens", {
    queryFn: ({ signal }) => apiAllPages<M2MTokenJSON>("/m2m/tokens", { signal }),
  });
  const machines = unwrapList<M2MMachineJSON>(machinesQuery.data);
  const tokens = unwrapList<M2MTokenJSON>(tokensQuery.data);

  const [machineOpen, setMachineOpen] = useState(false);
  const [machineForm, setMachineForm] = useState<MachineForm>(EMPTY_MACHINE);
  const [machineSaving, setMachineSaving] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string | null } | null>(null);
  const [rotating, setRotating] = useState<M2MMachineJSON | null>(null);
  const [rotatingBusy, setRotatingBusy] = useState(false);
  const [mintOpen, setMintOpen] = useState(false);
  const [mint, setMint] = useState<MintForm>(EMPTY_MINT);
  const [minting, setMinting] = useState(false);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<M2MTokenJSON | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const machineName = (id: string) => machines.find((machine) => machine.id === id)?.name ?? id;

  const openCreate = () => {
    setMachineForm(EMPTY_MACHINE);
    setMachineOpen(true);
  };
  const openEdit = (machine: M2MMachineJSON) => {
    setMachineForm({
      id: machine.id,
      name: machine.name,
      ttl: String(machine.default_token_ttl),
      scopedMachines: machine.scoped_machines ?? [],
    });
    setMachineOpen(true);
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
      setMachineOpen(false);
      if (!machineForm.id) {
        setSecret({ title: `Machine ${body.name} created`, value: oneTimeSecret(response) });
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
      setSecret({ title: `Secret rotated for ${rotating.name}`, value: oneTimeSecret(response) });
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

  return {
    machineOpen,
    setMachineOpen,
    machineForm,
    setMachineForm,
    machineSaving,
    secret,
    setSecret,
    rotating,
    setRotating,
    rotatingBusy,
    mintOpen,
    setMintOpen,
    mint,
    setMint,
    minting,
    mintedToken,
    setMintedToken,
    revoking,
    setRevoking,
    revokeBusy,
    machinesQuery,
    tokensQuery,
    machines,
    tokens,
    machineName,
    openCreate,
    openEdit,
    machineErrors,
    ttl,
    saveMachine,
    rotateSecret,
    mintErrors,
    claimsParsed,
    mintToken,
    revokeToken,
    toggleScopedMachine,
  };
}

export type M2MController = ReturnType<typeof useM2M>;
