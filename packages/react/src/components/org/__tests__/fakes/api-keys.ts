import { type ApiKeyJSON } from "@orbitid/shared";
import type { ApiKeyResource } from "../../../../provider";
import type { FakeBackend } from "./types";

export function createFakeApiKeys(backend: FakeBackend, notify: () => void) {
  const buildApiKey = (params: {
    name: string;
    description?: string;
    expiration?: number | null;
    scopes?: string[];
  }): ApiKeyJSON => {
    const index = backend.apiKeys.length + 1;
    return {
      object: "api_key",
      id: `key_${index}`,
      name: params.name,
      description: params.description ?? null,
      subject: backend.self.id,
      prefix: `ak_live_${index}`,
      secret: `ak_live_secret_${index}`,
      scopes: params.scopes ?? [],
      claims: null,
      revoked: false,
      expiration: params.expiration ?? null,
      last_used_at: null,
      created_by: backend.self.id,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  };

  const apiKeyResource = (key: ApiKeyJSON): ApiKeyResource => ({
    id: key.id,
    name: key.name,
    description: key.description,
    subject: key.subject,
    prefix: key.prefix,
    scopes: key.scopes,
    claims: key.claims,
    revoked: key.revoked,
    expiration: key.expiration,
    lastUsedAt: key.last_used_at,
    createdAt: key.created_at,
    createdBy: key.created_by,
    updatedAt: key.updated_at,
    secret: key.secret,
    revoke: async () => {
      backend.apiKeys = backend.apiKeys.map((candidate) =>
        candidate.id === key.id ? { ...candidate, revoked: true } : candidate,
      );
      notify();
    },
  });

  const revokeKey = (id: string) => {
    backend.apiKeys = backend.apiKeys.map((key) =>
      key.id === id ? { ...key, revoked: true } : key,
    );
  };


  return { buildApiKey, apiKeyResource, revokeKey };
}
