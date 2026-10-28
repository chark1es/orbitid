import { describe, it, expect, vi } from "vitest";
import type { OrganizationInvitationJSON } from "@orbitid/shared";

vi.mock("../../src/services/mail", () => ({ sendEmail: async () => {}, sendSms: async () => {} }));
vi.mock("../../src/services/webhooks", () => ({ emitEvent: async () => {}, startWebhookWorker: () => () => {} }));

import { api, createOrg, invite, seedAuth, seedUser, setup } from "./helpers";

describe("organization details exposed to clients", () => {
  it("names the organization on a user's pending invitations", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme Robotics");
    await invite(app, ownerAuth.cookie, org.id, "guest@acme.test");

    const guest = await seedUser(ctx, { email: "guest@acme.test", verified: true });
    const guestAuth = await seedAuth(ctx, guest.id);
    const list = await api<{ response: OrganizationInvitationJSON[] }>(app, "GET", "/v1/client/me/organization_invitations", { cookie: guestAuth.cookie });
    expect(list.body.response[0]).toMatchObject({ organization_name: "Acme Robotics", organization_id: org.id });
  });

  it("publishes the per-user organization limit in the environment", async () => {
    const { app } = await setup({ organizations: { maxCreatedOrganizationsPerUser: 3 } });
    const env = await api<{ organization_settings: { max_created_organizations_per_user: number | null } }>(app, "GET", "/v1/client/environment");
    expect(env.body.organization_settings.max_created_organizations_per_user).toBe(3);
  });
});
