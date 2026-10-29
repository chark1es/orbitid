import { describe, expect, it } from "vitest";
import { setup } from "./core/helpers";

const KEY = "sk_test_domains";

async function boot() {
  const { app } = await setup({ secretKey: KEY });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
  };
  const connection = (domains: string[], extra: Record<string, unknown> = {}) => ({
    name: `Conn ${domains.join(",")}`, protocol: "oidc", provider: "custom", domains, active: false,
    client_id: "cid", client_secret: "secret", discovery_url: "https://idp.example.com/.well-known/openid-configuration", ...extra,
  });
  return { call, connection };
}

describe("enterprise connection domains", () => {
  it("gives each domain to exactly one connection", async () => {
    const { call, connection } = await boot();
    expect((await call("POST", "/v1/enterprise_connections", connection(["acme.test"]))).status).toBe(201);
    const clash = await call("POST", "/v1/enterprise_connections", connection(["acme.test"]));
    expect(clash.status).toBe(409);
    expect((await call("POST", "/v1/enterprise_connections", connection(["other.test"]))).status).toBe(201);
  });

  it("treats subdomains as taken when the owner allows them", async () => {
    const { call, connection } = await boot();
    await call("POST", "/v1/enterprise_connections", connection(["acme.test"], { allow_subdomains: true }));
    expect((await call("POST", "/v1/enterprise_connections", connection(["eu.acme.test"]))).status).toBe(409);
    // A parent claiming subdomains over an existing child is refused too.
    await call("POST", "/v1/enterprise_connections", connection(["x.beta.test"]));
    expect((await call("POST", "/v1/enterprise_connections", connection(["beta.test"], { allow_subdomains: true }))).status).toBe(409);
  });

  it("applies the same rule on update and lets a connection keep its own domains", async () => {
    const { call, connection } = await boot();
    const first = await call("POST", "/v1/enterprise_connections", connection(["one.test"]));
    const second = await call("POST", "/v1/enterprise_connections", connection(["two.test"]));
    const steal = await call("PATCH", `/v1/enterprise_connections/${second.body.id}`, { domains: ["one.test"] });
    expect(steal.status).toBe(409);
    const keep = await call("PATCH", `/v1/enterprise_connections/${first.body.id}`, { domains: ["one.test", "uno.test"] });
    expect(keep.status).toBe(200);
  });
});
