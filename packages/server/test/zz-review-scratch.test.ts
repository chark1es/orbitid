import { describe, it } from "vitest";
import { setup, signUpUser, testClient } from "./core/helpers";
import { latestLinkFor } from "../src/services/mail";

describe("magic link login-CSRF", () => {
  it("attacker's client gets a session when the victim clicks the emailed link", async () => {
    const { app } = await setup();
    const victim = await signUpUser(app, { email: "victim@example.com", password: "Sup3rSecret!" });

    const attacker = testClient(app);
    const created = await attacker.json<any>("/v1/client/sign_ins", { body: { identifier: "victim@example.com", strategy: "email_link" } });
    await attacker.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const link = latestLinkFor("victim@example.com")!;
    console.log("link:", link.slice(0, 90));

    const victimBrowser = testClient(app);
    const click = await victimBrowser.request(link.replace("http://localhost:4000", ""));
    console.log("victim click ->", click.status, (click.headers.get("location") ?? "").slice(0, 90));

    const state = await attacker.json<any>("/v1/client");
    const session = state.client.sessions.find((s: any) => s.status === "active");
    console.log("attacker session user:", session?.user?.id, "victim:", victim.userId, "match:", session?.user?.id === victim.userId);
    const me = await attacker.request("/v1/client/me");
    console.log("attacker /me ->", me.status);
  });
});
