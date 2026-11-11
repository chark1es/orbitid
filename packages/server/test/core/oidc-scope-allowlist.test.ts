// The application's `scopes` field is an allowlist. Base scopes are not granted implicitly: an app that never asked
// for `groups`, `organizations` or `offline_access` must not disclose them (especially with consent disabled).
import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { authHeaders, insertClientSession, insertUser, setup } from "../machine/helpers";
import { REDIRECT_URI, challengeFor, type Harness } from "./oidc-provider-helpers";

describe("OIDC — application scope allowlist", () => {
  let h: Harness;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;

  beforeEach(async () => {
    h = await setup();
    user = await insertUser(h.ctx);
    session = await insertClientSession(h.ctx, user.userId);
  });

  async function createApp(body: Record<string, unknown> = {}) {
    const res = await h.app.request("/v1/oauth_applications", {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({ name: "Scoped app", redirect_uris: [REDIRECT_URI], consent_screen_enabled: false, ...body }),
    });
    expect(res.status).toBe(201);
    return res.json() as Promise<{ client_id: string; client_secret?: string; scopes: string; groups_claim: string; access_token_lifetime_seconds: number }>;
  }

  async function authorize(clientId: string, scope: string) {
    const verifier = createHash("sha256").update("verifier").digest("base64url");
    return h.app.request(`/oauth/authorize?${new URLSearchParams({
      client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope,
      state: "s", code_challenge: challengeFor(verifier), code_challenge_method: "S256",
    })}`, { headers: { cookie: session.cookie } });
  }

  it("defaults new applications to openid profile email, no groups claim and a short access token", async () => {
    const app = await createApp();
    expect(app.scopes).toBe("openid profile email");
    expect(app.groups_claim).toBe("none");
    expect(app.access_token_lifetime_seconds).toBeLessThanOrEqual(300);
  });

  it("refuses scopes the application did not configure", async () => {
    const app = await createApp();
    for (const scope of ["openid profile email groups", "openid offline_access", "openid organizations", "openid custom_scope"]) {
      const response = await authorize(app.client_id, scope);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.searchParams.get("error")).toBe("invalid_scope");
      expect(location.searchParams.get("code")).toBeNull();
    }
  });

  it("allows a scope once the operator configures it", async () => {
    const app = await createApp({ scopes: "openid profile email groups offline_access" });
    const groups = await authorize(app.client_id, "openid profile email groups offline_access");
    const location = new URL(groups.headers.get("location")!);
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.searchParams.get("code")).toMatch(/^oac_/);
  });

  it("always allows openid even on an application that configured nothing else", async () => {
    const app = await createApp({ scopes: "" });
    const response = await authorize(app.client_id, "openid");
    expect(new URL(response.headers.get("location")!).searchParams.get("code")).toMatch(/^oac_/);
    const refused = await authorize(app.client_id, "openid email");
    expect(new URL(refused.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
  });
});
