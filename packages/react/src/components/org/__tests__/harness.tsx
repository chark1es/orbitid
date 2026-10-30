import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { encodePublishableKey } from "@orbitid/shared";
import { OrbitIDProvider } from "../../../provider";
import type { OrbitIDInstance, OrbitIDState, OrganizationResource } from "../../../provider";
import "./fakes/dom-polyfills";
import { createFakeBackend, apiError, ADMIN_PERMISSIONS } from "./fakes/backend";
import { counters } from "./fakes/counters";
import { createFakeApiKeys } from "./fakes/api-keys";
import { createFakeOrgResources } from "./fakes/org-resources";
import { createFakeFetch } from "./fakes/fetch";
import type { FakeBackend, FakeInstance, FakeOrg } from "./fakes/types";

export function createFakeInstance(providedBackend?: Partial<FakeBackend>): FakeInstance {
  const backend = createFakeBackend(providedBackend);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  const keys = createFakeApiKeys(backend, notify);
  const orgs = createFakeOrgResources(backend, notify, keys);
  const fakeFetch = createFakeFetch(backend, notify, orgs, keys);
  const { activeOrg, orgResource, userResource } = orgs;
  const { buildApiKey, apiKeyResource, revokeKey } = keys;

  let instance: OrbitIDInstance;
  const syncOrganization = () => {
    const org = activeOrg();
    instance.organization = org ? orgResource(org) : null;
  };

  instance = {
    loaded: true,
    publishableKey: encodePublishableKey("https://api.test"),
    client: { id: "client_1", sessions: [] } as unknown as OrbitIDInstance["client"],
    session: {
      id: "sess_1",
      status: "active",
      publicUserData: { userId: backend.self.id, identifier: backend.self.identifier },
      lastActiveOrganizationId: backend.activeOrgId,
    } as unknown as OrbitIDInstance["session"],
    user: userResource(),
    organization: null,
    environment: {
      organization_settings: backend.organizationSettings,
    } as unknown as OrbitIDInstance["environment"],
    signIn: undefined,
    signUp: undefined,
    options: { fetch: fakeFetch },
    addListener: (callback: (state: OrbitIDState) => void) => {
      listeners.add(callback as () => void);
      return () => {
        listeners.delete(callback as () => void);
      };
    },
    load: async () => {},
    setActive: async ({ organization }: { organization?: string | OrganizationResource | null }) => {
      const id = typeof organization === "string" ? organization : (organization?.id ?? null);
      backend.activeOrgId = id;
      backend.calls.setActive.push(id);
      instance.session = {
        ...(instance.session as unknown as Record<string, unknown>),
        lastActiveOrganizationId: id,
      } as unknown as OrbitIDInstance["session"];
      syncOrganization();
      notify();
    },
    signOut: async () => {},
    apiKeys: {
      list: async () => ({
        data: backend.apiKeys.map(apiKeyResource),
        totalCount: backend.apiKeys.length,
      }),
      create: async (params: {
        name: string;
        description?: string;
        expiration?: number | null;
        scopes?: string[];
      }) => {
        const key = buildApiKey(params);
        backend.apiKeys = [key, ...backend.apiKeys];
        return apiKeyResource(key);
      },
      revoke: async (id: string) => {
        revokeKey(id);
        notify();
      },
    },
    createOrganization: async ({ name, slug }: { name: string; slug?: string }) => {
      const resolvedSlug = slug ?? name.toLowerCase().replace(/\s+/g, "-");
      if (backend.orgs.some((candidate) => candidate.slug === resolvedSlug)) {
        throw apiError("organization_slug_taken");
      }
      const created: FakeOrg = {
        id: `org_${++counters.org}`,
        name,
        slug: resolvedSlug,
      };
      backend.orgs = [...backend.orgs, created];
      backend.members[created.id] = [
        {
          userId: backend.self.id,
          firstName: backend.self.firstName,
          lastName: backend.self.lastName,
          identifier: backend.self.identifier,
          role: "org:admin",
          permissions: ADMIN_PERMISSIONS,
        },
      ];
      notify();
      return orgResource(created);
    },
    getOrganization: async (organizationId: string) => {
      const org = backend.orgs.find((candidate) => candidate.id === organizationId);
      if (!org) throw apiError("organization_not_found");
      return orgResource(org);
    },
    navigate: (to: string) => {
      backend.calls.navigate.push(to);
    },
  };

  syncOrganization();

  return {
    instance,
    backend,
    notify,
    unmountListeners: () => listeners.clear(),
  };
}

/** Renders `ui` inside the real provider with the fake instance. */
export function renderWithOrbit(
  ui: ReactElement,
  fake: FakeInstance = createFakeInstance(),
): RenderResult & { fake: FakeInstance } {
  const result = render(
    <OrbitIDProvider orbit={fake.instance} publishableKey="pk_test_harness">
      {ui}
    </OrbitIDProvider>,
  );
  return Object.assign(result, { fake });
}

export * from "./fakes/types";
export { createFakeBackend } from "./fakes/backend";
