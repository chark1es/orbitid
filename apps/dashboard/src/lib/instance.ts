import { useQuery } from "@tanstack/react-query";
import type { InstanceSettings } from "@orbitid/shared";
import { API_URL, getApiUrl, useApi } from "./api";

export interface HealthJSON {
  status: string;
  publishable_key: string;
}

/** Public health endpoint lives outside `/v1` and needs no key. */
export async function fetchHealth(): Promise<HealthJSON> {
  const res = await fetch(`${getApiUrl()}/health`);
  if (!res.ok) throw new Error(`Health check failed (${res.status})`);
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") throw new Error("Health check returned an unexpected body");
  return {
    status: "status" in body && typeof body.status === "string" ? body.status : "unknown",
    publishable_key: "publishable_key" in body && typeof body.publishable_key === "string" ? body.publishable_key : "",
  };
}

export function useHealth() {
  return useQuery({ queryKey: ["health", getApiUrl()], queryFn: fetchHealth, staleTime: 60_000, retry: 1 });
}

export function useInstance() {
  return useApi<InstanceSettings>(["instance"], "/instance");
}

/** App origin that impersonation/`sign_in_token` URLs redirect to. */
export function homeUrlOf(instance: InstanceSettings | undefined): string | undefined {
  const home = instance?.application?.homeUrl;
  return home && home.trim() ? home : undefined;
}

export { API_URL };
