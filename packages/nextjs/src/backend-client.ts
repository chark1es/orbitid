import { createOrbitIdClient, type OrbitIdClient } from "@orbitid/backend";
import { getServerEnv } from "./env";

function resolveBackendConfig(): { secretKey: string; apiUrl: string } {
  const env = getServerEnv();
  if (!env.secretKey) {
    throw new Error(
      "@orbitid/nextjs: ORBITID_SECRET_KEY is required for `orbitIdClient()` / `currentUser()`",
    );
  }
  return { secretKey: env.secretKey, apiUrl: env.apiUrl };
}

const clients = new Map<string, OrbitIdClient>();

/**
 * Backend API client singleton (secret-key authenticated), keyed by API URL + secret so tests and
 * multi-instance deployments do not share a client. Configure with `ORBITID_SECRET_KEY` and
 * `NEXT_PUBLIC_ORBITID_API_URL`.
 */
export function orbitIdClient(): OrbitIdClient {
  const { secretKey, apiUrl } = resolveBackendConfig();
  const key = `${apiUrl}\u0000${secretKey}`;
  const existing = clients.get(key);
  if (existing) return existing;
  const client = createOrbitIdClient({ secretKey, apiUrl });
  clients.set(key, client);
  return client;
}
