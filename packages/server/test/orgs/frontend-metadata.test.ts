import { describe, it, expect, vi } from "vitest";
import type { OrganizationJSON } from "@orbitid/shared";

vi.mock("../../src/services/mail", () => ({ sendEmail: async () => {}, sendSms: async () => {} }));
vi.mock("../../src/services/webhooks", () => ({ emitEvent: async () => {}, startWebhookWorker: () => () => {} }));

import { api, backend, seedAuth, seedUser, setup } from "./helpers";

describe("frontend organization writes", () => {
  it("cannot set public or private metadata; only the Backend API can", async () => {
    const { ctx, app } = await setup();
    const owner = seedUser(ctx, { email: "owner@acme.test" });
    const { cookie } = seedAuth(ctx, owner.id);

    const created = await api<{ response: OrganizationJSON }>(app, "POST", "/v1/client/organizations", {
      cookie,
      body: { name: "Acme", public_metadata: { plan: "enterprise" }, private_metadata: { billing: "free-forever" } },
    });
    expect(created.status).toBe(200);
    const id = created.body.response.id;

    await api(app, "PATCH", `/v1/client/organizations/${id}`, { cookie, body: { private_metadata: { billing: "free-forever" }, public_metadata: { plan: "enterprise" } } });

    const stored = await backend<OrganizationJSON>(app, "GET", `/v1/organizations/${id}`);
    expect(stored.body.public_metadata).toEqual({});
    expect(stored.body.private_metadata).toEqual({});
  });
});
