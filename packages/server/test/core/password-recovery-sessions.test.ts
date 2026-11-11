// Forgotten-password recovery is a credential reset: every other session, OIDC grant and trusted device must end,
// and a notification-mail failure must not leave the attacker's session alive. The recovering browser stays in.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { latestCodeFor, setMailTransport } from "../../src/services/mail";
import { insertClientSession, insertUser, setup } from "../machine/helpers";
import { getClient, signInWithPassword, signUpUser, testClient } from "./helpers";
import { codeFlow, createApp, form, type Harness } from "./oidc-provider-helpers";

async function beginRecovery(app: Harness["app"], email: string) {
  const client = testClient(app);
  const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
    body: { identifier: email, strategy: "reset_password_email_code" },
  });
  await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "reset_password_email_code" } });
  const code = latestCodeFor(email, "reset_password_code")!;
  const verified = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
    body: { strategy: "reset_password_email_code", code },
  });
  if (verified.response.status !== "needs_new_password") throw new Error(`unexpected status ${verified.response.status}`);
  return { client, signInId: created.response.id };
}

describe("forgotten-password recovery", () => {
  afterEach(() => setMailTransport(null));

  it("ends other sessions and OIDC grants before notifying, even when the mail transport fails", async () => {
    const h = await setup();
    const victim = await signUpUser(h.app);
    const attacker = await signInWithPassword(h.app, victim.email, victim.password);

    const oauthApp = await createApp(h);
    const grants = await codeFlow(h, oauthApp, attacker.client.cookie!);
    const userinfo = (token: string) => h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${token}` } });
    const refresh = () => form(h, "/oauth/token", {
      grant_type: "refresh_token", refresh_token: grants.tokens.refresh_token!,
      client_id: oauthApp.client_id!, client_secret: oauthApp.client_secret ?? "",
    });
    expect((await userinfo(grants.tokens.access_token)).status).toBe(200);

    const recovery = await beginRecovery(h.app, victim.email);
    // The reset notification will fail. Revocation must already have happened.
    setMailTransport(async () => { throw new Error("smtp is down"); });
    const done = await recovery.client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${recovery.signInId}/reset_password`, {
      body: { password: "N3w-Recovery-Pass!" },
    });
    expect(done.response.status).toBe("complete");

    // The attacker's browser is signed out and its RP tokens are dead.
    expect((await getClient(attacker.client)).response.sessions.filter((session) => session.status === "active")).toHaveLength(0);
    expect((await userinfo(grants.tokens.access_token)).status).toBe(401);
    expect((await refresh()).status).toBe(400);
    const stored = await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.applicationId, oauthApp.id));
    expect(stored.every((row) => row.revoked)).toBe(true);

    // The recovering browser is signed in with the new password.
    const recovered = await getClient(recovery.client);
    expect(recovered.response.sessions.filter((session) => session.status === "active")).toHaveLength(1);
  });

  it("keeps other sessions when the reset preference is turned off", async () => {
    const h = await setup();
    await h.ctx.settings.update({ password: { signOutOfOtherSessionsOnReset: false } });
    const victim = await signUpUser(h.app);
    const attacker = await signInWithPassword(h.app, victim.email, victim.password);
    const other = await insertClientSession(h.ctx, (await insertUser(h.ctx, { email: null })).userId);

    const recovery = await beginRecovery(h.app, victim.email);
    await recovery.client.json(`/v1/client/sign_ins/${recovery.signInId}/reset_password`, { body: { password: "N3w-Recovery-Pass!" } });

    expect((await getClient(attacker.client)).response.sessions.filter((session) => session.status === "active")).toHaveLength(1);
    // An unrelated user's session is never touched by this user's recovery.
    expect((await getClient(testClient(h.app, other.cookie))).response.sessions.filter((session) => session.status === "active")).toHaveLength(1);
  });
});
