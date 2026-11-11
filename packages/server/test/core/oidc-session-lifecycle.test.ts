// A session ending must end the OIDC credentials it authorized; grants without a browser session keep their own
// lifecycle. Access tokens default short so an ended session cannot be used offline for an hour.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ID_PREFIX } from "@orbitid/shared";
import * as schema from "../../src/db/schema";
import { randomToken, sha256 } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";
import { authHeaders, insertClientSession, insertUser, setup } from "../machine/helpers";
import { basic, codeFlow, createApp, form, type Harness } from "./oidc-provider-helpers";
import { authorizingSessionActive } from "../../src/services/oidc/tokens";

describe("OIDC — session lifecycle", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;
  let app: { id: string; client_id: string; client_secret?: string };

  beforeEach(async () => {
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
    app = await createApp(h);
  });

  const refresh = (token: string) => form(h, "/oauth/token", {
    grant_type: "refresh_token", refresh_token: token, client_id: app.client_id!, client_secret: app.client_secret ?? "",
  });
  const userinfo = (token: string) => h.app.request("/oauth/userinfo", { headers: { authorization: `Bearer ${token}` } });
  const introspect = (token: string) => form(h, "/oauth/introspect", { token }, basic(app.client_id!, app.client_secret!));
  const backend = (method: string, path: string) => h.app.request(path, { method, headers: authHeaders() });

  it("self sign-out revokes the linked access and refresh tokens", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    const ended = await h.app.request(`/v1/client/sessions/${session.sessionId}/end`, {
      method: "POST", headers: { cookie: session.cookie },
    });
    expect(ended.status).toBe(200);

    expect((await userinfo(tokens.access_token)).status).toBe(401);
    expect(await (await introspect(tokens.access_token)).json()).toEqual({ active: false });
    expect(await (await introspect(tokens.refresh_token!)).json()).toEqual({ active: false });
    expect((await refresh(tokens.refresh_token!)).status).toBe(400);
  });

  it("an operator revoke revokes them too", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    const revoked = await backend("POST", `/v1/sessions/${session.sessionId}/revoke`);
    expect(revoked.status).toBe(200);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    expect((await refresh(tokens.refresh_token!)).status).toBe(400);
  });

  it("a ban revokes grants and an unban does not resurrect them", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    expect((await backend("POST", `/v1/users/${user.userId}/ban`)).status).toBe(200);
    expect((await backend("POST", `/v1/users/${user.userId}/unban`)).status).toBe(200);

    const stored = await h.ctx.db.select().from(schema.oauthGrants).where(eq(schema.oauthGrants.userId, user.userId));
    expect(stored.every((row) => row.revoked)).toBe(true);
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    expect((await refresh(tokens.refresh_token!)).status).toBe(400);
  });

  it("checks the authorizing session on refresh, userinfo and introspection even while the grant row is live", async () => {
    const { tokens } = await codeFlow(h, app, session.cookie);
    // End the session behind the service's back, leaving the grant rows unrevoked: the checks themselves must notice.
    await h.ctx.db.update(schema.sessions).set({ status: "ended" }).where(eq(schema.sessions.id, session.sessionId));
    expect((await userinfo(tokens.access_token)).status).toBe(401);
    expect(await (await introspect(tokens.access_token)).json()).toEqual({ active: false });
    expect((await refresh(tokens.refresh_token!)).status).toBe(400);
    expect(await authorizingSessionActive(h.ctx, session.sessionId)).toBe(false);
  });

  it("keeps grants without a browser session on their own lifecycle", async () => {
    // Device-flow style grant: no `session_id`. Ending every browser session must not end it.
    const now = Date.now();
    const access = `oat_${randomToken(32)}`;
    const refreshToken = `ort_${randomToken(32)}`;
    const family = randomToken(9);
    await h.ctx.db.insert(schema.oauthGrants).values({
      id: newId(ID_PREFIX.oauthGrant), kind: "access", applicationId: app.id, userId: user.userId,
      tokenHash: sha256(access), scopes: "openid offline_access", redirectUri: null, codeChallenge: null,
      codeChallengeMethod: null, sessionId: null, familyId: family, revoked: false,
      expiresAt: now + 3_600_000, createdAt: now,
    });
    await h.ctx.db.insert(schema.oauthGrants).values({
      id: newId(ID_PREFIX.oauthGrant), kind: "refresh", applicationId: app.id, userId: user.userId,
      tokenHash: sha256(refreshToken), scopes: "openid offline_access", redirectUri: null, codeChallenge: null,
      codeChallengeMethod: null, sessionId: null, familyId: family, revoked: false,
      expiresAt: now + 86_400_000, createdAt: now,
    });

    expect((await userinfo(access)).status).toBe(200);
    await h.ctx.db.update(schema.sessions).set({ status: "revoked" }).where(eq(schema.sessions.userId, user.userId));
    expect((await userinfo(access)).status).toBe(200);
    expect((await refresh(refreshToken)).status).toBe(200);
  });

  it("defaults new applications to a short access-token lifetime but honours a longer one", async () => {
    const defaultCreated = await h.app.request("/v1/oauth_applications", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ name: "Default", redirect_uris: ["http://localhost:3000/callback"], consent_screen_enabled: false, scopes: "openid offline_access" }),
    });
    const defaultApp = await defaultCreated.json() as { client_id: string; client_secret?: string; access_token_lifetime_seconds: number };
    expect(defaultApp.access_token_lifetime_seconds).toBeLessThanOrEqual(300);

    const short = await codeFlow(h, defaultApp, session.cookie, "openid offline_access");
    expect(Number(short.tokens.expires_in)).toBeLessThanOrEqual(300);

    const longerCreated = await h.app.request("/v1/oauth_applications", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ name: "Long", redirect_uris: ["http://localhost:3000/callback"], consent_screen_enabled: false, scopes: "openid", access_token_lifetime_seconds: 3600 }),
    });
    const longer = await longerCreated.json() as { client_id: string; client_secret?: string };
    const longTokens = await codeFlow(h, longer, session.cookie, "openid");
    expect(Number(longTokens.tokens.expires_in)).toBe(3600);
  });
});
