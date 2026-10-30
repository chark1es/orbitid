import { ADMIN_PERMISSIONS, MEMBER_PERMISSIONS, apiError } from "./backend";
import type { createFakeApiKeys } from "./api-keys";
import type { createFakeOrgResources } from "./org-resources";
import type { FakeBackend } from "./types";

type FakeOrgResources = ReturnType<typeof createFakeOrgResources>;
type FakeApiKeys = ReturnType<typeof createFakeApiKeys>;

export function createFakeFetch(
  backend: FakeBackend,
  notify: () => void,
  orgs: FakeOrgResources,
  keys: FakeApiKeys,
) {
  const { selfMember, orgResource, memberResource, addInvitation, invitationResource, domainResource, requestResource, suggestionResource } = orgs;
  const { buildApiKey, apiKeyResource, revokeKey } = keys;

  const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = new URL(input);
    const path = url.pathname.replace(/^\/v1\/client/, "");
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    backend.calls.fetch.push({ method, path, body });

    const respond = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    const invitationAccept = /^\/me\/organization_invitations\/([^/]+)\/accept$/.exec(path);
    if (method === "POST" && invitationAccept) {
      const invitation = backend.userInvitations.find(
        (candidate) => candidate.id === decodeURIComponent(invitationAccept[1]!),
      );
      if (!invitation) {
        return respond(apiError("resource_not_found"), 404);
      }
      backend.userInvitations = backend.userInvitations.filter(
        (candidate) => candidate.id !== invitation.id,
      );
      const org = backend.orgs.find((candidate) => candidate.id === invitation.organizationId);
      if (!org) return respond(apiError("organization_not_found"), 404);
      backend.members[org.id] = [
        ...(backend.members[org.id] ?? []),
        {
          userId: backend.self.id,
          firstName: backend.self.firstName,
          lastName: backend.self.lastName,
          identifier: backend.self.identifier,
          role: invitation.role,
          permissions: invitation.role === "org:admin" ? ADMIN_PERMISSIONS : MEMBER_PERMISSIONS,
        },
      ];
      notify();
      return respond({ response: memberResource(org, selfMember(org.id)!) });
    }

    const apiKeyRevoke = /^\/(?:me|organizations\/([^/]+))\/api_keys\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && apiKeyRevoke) {
      const id = decodeURIComponent(apiKeyRevoke[2]!);
      revokeKey(id);
      return respond({ response: backend.apiKeys.find((key) => key.id === id) });
    }

    const apiKeys = /^\/(?:me|organizations\/([^/]+))\/api_keys$/.exec(path);
    if (apiKeys) {
      if (method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? backend.apiKeys.length);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        return respond({
          response: backend.apiKeys.slice(offset, offset + limit),
          total_count: backend.apiKeys.length,
        });
      }
      if (method === "POST") {
        const key = buildApiKey(
          (body ?? {}) as {
            name: string;
            description?: string;
            expiration?: number | null;
            scopes?: string[];
          },
        );
        backend.apiKeys = [key, ...backend.apiKeys];
        return respond({ response: key });
      }
    }

    return respond(apiError("resource_not_found"), 404);
  };


  return fakeFetch;
}
