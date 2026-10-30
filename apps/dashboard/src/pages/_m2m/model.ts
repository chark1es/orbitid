import { formatJson } from "../_config/settings";

export interface MachineForm {
  id?: string;
  name: string;
  ttl: string;
  scopedMachines: string[];
}
export interface MintForm {
  machineId: string;
  ttl: string;
  claimsText: string;
}

export const EMPTY_MACHINE: MachineForm = { name: "", ttl: "3600", scopedMachines: [] };
export const EMPTY_MINT: MintForm = { machineId: "", ttl: "3600", claimsText: formatJson({}) };
