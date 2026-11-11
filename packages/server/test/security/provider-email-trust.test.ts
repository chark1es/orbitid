// Only an assertion the provider actually made may mark an email verified (it decides account linking).
import { describe, expect, it } from "vitest";
import { setSafeFetchTransportForTests } from "../../src/lib/safe-fetch";
import { setup } from "../core/helpers";
import { getOAuthAdapter } from "../../src/services/oauth-providers";
import { mappedProfile } from "../../src/services/oauth-providers/custom";
import { profileEmailMayLink } from "../../src/services/external-identity";

async function profileFor(key: string, userinfo: unknown, extra: Record<string, unknown> = {}) {
  const { ctx } = await setup();
  await ctx.settings.update({ social: { [key]: { enabled: true, clientId: "id", clientSecret: "secret" } } });
  setSafeFetchTransportForTests(async (url) => {
    const body = url.pathname.endsWith("/user/emails") ? (extra.githubEmails ?? []) : userinfo;
    return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: JSON.stringify(body) };
  });
  try {
    const adapter = await getOAuthAdapter(ctx, key);
    return await adapter!.fetchProfile({ tokens: { accessToken: "t", tokenType: "Bearer" } as never });
  } finally {
    setSafeFetchTransportForTests(null);
  }
}

describe("provider email trust", () => {
  it("does not trust GitHub's public profile email, but trusts a verified primary one", async () => {
    const publicOnly = await profileFor("github", { id: 1, login: "mallory", email: "victim@example.com" }, { githubEmails: [] });
    expect(publicOnly.email).toBe("victim@example.com");
    expect(publicOnly.emailVerified).toBe(false);
    const verified = await profileFor("github", { id: 2, login: "ada", email: "public@example.com" }, {
      githubEmails: [{ email: "ada@example.com", primary: true, verified: true }, { email: "public@example.com", primary: false, verified: false }],
    });
    expect(verified.email).toBe("ada@example.com");
    expect(verified.emailVerified).toBe(true);
  });

  it("does not trust a Microsoft address with no verification claim", async () => {
    const profile = await profileFor("microsoft", { sub: "m1", email: "victim@example.com" });
    expect(profile.emailVerified).toBe(false);
  });

  it("honors Google's email_verified flag either way", async () => {
    expect((await profileFor("google", { sub: "g1", email: "a@example.com", email_verified: true })).emailVerified).toBe(true);
    expect((await profileFor("google", { sub: "g2", email: "a@example.com", email_verified: false })).emailVerified).toBe(false);
    expect((await profileFor("google", { sub: "g3", email: "a@example.com" })).emailVerified).toBe(false);
  });

  it("trustEmailVerified only fills an ABSENT claim, never an explicit false", () => {
    const cfg = { key: "custom_test", clientId: "id", clientSecret: "secret", trustEmailVerified: true };
    const tokens = { accessToken: "t", raw: {} };

    const explicitFalse = mappedProfile(cfg as never, { sub: "1", email: "victim@example.com", email_verified: false }, tokens as never);
    expect(explicitFalse.emailVerified).toBe(false);
    expect(profileEmailMayLink(explicitFalse)).toBe(false);

    const stringFalse = mappedProfile(cfg as never, { sub: "2", email: "victim@example.com", email_verified: "false" }, tokens as never);
    expect(stringFalse.emailVerified).toBe(false);
    expect(profileEmailMayLink(stringFalse)).toBe(false);

    const numericFalse = mappedProfile(cfg as never, { sub: "3", email: "victim@example.com", email_verified: 0 }, tokens as never);
    expect(numericFalse.emailVerified).toBe(false);
    expect(profileEmailMayLink(numericFalse)).toBe(false);

    // No claim at all: the operator's explicit promise applies.
    const absent = mappedProfile(cfg as never, { sub: "4", email: "ada@example.com" }, tokens as never);
    expect(absent.emailVerified).toBe(true);
    expect(profileEmailMayLink(absent)).toBe(true);

    // Without the promise an absent claim is unverified.
    const untrusted = mappedProfile({ ...cfg, trustEmailVerified: false } as never, { sub: "5", email: "ada@example.com" }, tokens as never);
    expect(untrusted.emailVerified).toBe(false);
    expect(profileEmailMayLink(untrusted)).toBe(false);
  });
});
