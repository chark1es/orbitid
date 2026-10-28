import { describe, it, expect } from "vitest";
import type { OrganizationJSON } from "@orbitid/shared";
import { api, backend, createOrg, errorCode, invite, seedAuth, seedUser, setup } from "./helpers";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const dataUrl = `data:image/png;base64,${PNG}`;

const pathOf = (url: string) => new URL(url).pathname;

describe("organization logos", () => {
  it("uploads, serves, replaces and deletes logos through the Frontend API", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");

    const uploaded = await api<{ response: OrganizationJSON }>(app, "PUT", `/v1/client/organizations/${org.id}/logo`, { cookie: ownerAuth.cookie, body: { file: dataUrl } });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body.response.has_image).toBe(true);
    const imageUrl = uploaded.body.response.image_url;
    expect(imageUrl).toContain("/v1/client/organization_logos/");

    const served = await app.request(pathOf(imageUrl));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(PNG);

    const replaced = await api<{ response: OrganizationJSON }>(app, "PUT", `/v1/client/organizations/${org.id}/logo`, { cookie: ownerAuth.cookie, body: { file: dataUrl } });
    expect(replaced.body.response.image_url).not.toBe(imageUrl);
    expect((await app.request(pathOf(imageUrl))).status).toBe(404);

    const unsupported = await api(app, "PUT", `/v1/client/organizations/${org.id}/logo`, { cookie: ownerAuth.cookie, body: { file: `data:text/plain;base64,${Buffer.from("hi").toString("base64")}` } });
    expect(unsupported.status).toBe(422);

    const svg = await api(app, "PUT", `/v1/client/organizations/${org.id}/logo`, { cookie: ownerAuth.cookie, body: { file: `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>").toString("base64")}` } });
    expect(svg.status).toBe(422);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");

    const removed = await api<{ response: OrganizationJSON }>(app, "DELETE", `/v1/client/organizations/${org.id}/logo`, { cookie: ownerAuth.cookie });
    expect(removed.body.response.has_image).toBe(false);
    expect((await app.request(pathOf(replaced.body.response.image_url))).status).toBe(404);

    expect((await app.request("/v1/client/organization_logos/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });

  it("requires the profile:manage permission and supports the Backend API", async () => {
    const { ctx, app } = await setup();
    const owner = await seedUser(ctx, { email: "owner@acme.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Acme");
    const member = await seedUser(ctx, { email: "member@acme.test" });
    const memberAuth = await seedAuth(ctx, member.id);
    const invitation = await invite(app, ownerAuth.cookie, org.id, "member@acme.test");
    await api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: memberAuth.cookie });

    const forbidden = await api(app, "PUT", `/v1/client/organizations/${org.id}/logo`, { cookie: memberAuth.cookie, body: { file: dataUrl } });
    expect(forbidden.status).toBe(403);
    expect(errorCode(forbidden.body)).toBe("org_permission_required");

    const viaBackend = await backend<OrganizationJSON>(app, "PUT", `/v1/organizations/${org.id}/logo`, { file: dataUrl });
    expect(viaBackend.status).toBe(200);
    expect(viaBackend.body.has_image).toBe(true);
    expect((await app.request(pathOf(viaBackend.body.image_url))).status).toBe(200);

    const deleted = await backend<OrganizationJSON>(app, "DELETE", `/v1/organizations/${org.id}/logo`);
    expect(deleted.body.has_image).toBe(false);
  });
});
