// A magic link only finishes a flow in the browser that started it.
import { describe, expect, it } from "vitest";
import { latestLinkFor } from "../../src/services/mail";
import { setup, signUpUser, testClient } from "../core/helpers";

const path = (link: string) => link.replace("http://localhost:4000", "");

describe("magic link binding", () => {
  it("does not sign an attacker in when the victim clicks a link the attacker requested", async () => {
    const { app } = await setup();
    await signUpUser(app, { email: "victim@example.com", password: "Sup3rSecret!" });

    const attacker = testClient(app);
    const created = await attacker.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: "victim@example.com", strategy: "email_link" } });
    await attacker.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const link = latestLinkFor("victim@example.com")!;

    const victimBrowser = testClient(app);
    const click = await victimBrowser.request(path(link));
    expect(click.headers.get("location")).toContain("__orbit_status=different_browser");

    const state = await attacker.json<{ client: { sessions: { status: string }[] } }>("/v1/client");
    expect(state.client.sessions.filter((s) => s.status === "active")).toHaveLength(0);
    expect((await attacker.request("/v1/client/me")).status).toBe(401);
  });

  it("still signs in when the same browser opens the link, even after a refused click elsewhere", async () => {
    const { app } = await setup();
    await signUpUser(app, { email: "owner@example.com", password: "Sup3rSecret!" });

    const browser = testClient(app);
    const created = await browser.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: "owner@example.com", strategy: "email_link" } });
    await browser.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const link = latestLinkFor("owner@example.com")!;

    const stranger = testClient(app);
    expect((await stranger.request(path(link))).headers.get("location")).toContain("different_browser");
    expect((await browser.request(path(link))).headers.get("location")).toContain("__orbit_status=verified");
    expect((await browser.request("/v1/client/me")).status).toBe(200);
  });

  it("does not let a stranger verify a sign-up they did not start", async () => {
    const { app } = await setup();
    const attacker = testClient(app);
    const created = await attacker.json<{ response: { id: string } }>("/v1/client/sign_ups", { body: { email_address: "victim2@example.com", password: "Sup3rSecret!" } });
    await attacker.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_link" } });
    const link = latestLinkFor("victim2@example.com")!;

    const victimBrowser = testClient(app);
    expect((await victimBrowser.request(path(link))).headers.get("location")).toContain("different_browser");
    const state = await attacker.json<{ client: { sessions: unknown[] } }>("/v1/client");
    expect(state.client.sessions).toHaveLength(0);
  });
});
