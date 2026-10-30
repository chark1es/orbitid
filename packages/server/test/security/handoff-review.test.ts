import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { COOKIES } from "@orbitid/shared";
import * as s from "../../src/db/schema";
import { exportDatabase, importDatabase } from "../../src/services/transfer";
import { createUser } from "../../src/services/users";
import { setup, testClient } from "../core/helpers";

describe("sign-up phone verification is bound to its number", () => {
  it.each([true, false])("handles a verified snapshot whose identifier matches=%s", async (matches) => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: {
      emailAddress: { enabled: false, required: false },
      password: { enabled: false, required: false },
      phoneNumber: { enabled: true, required: true, verifyAtSignUp: true },
    } });
    const client = testClient(app);
    const phone = "+15555550101";
    const started = await client.json<{ response: { id: string } }>("/v1/client/sign_ups", { body: { phone_number: phone } });
    // A concurrent verification and identifier change can leave this stale snapshot in storage.
    // Completion must check its identifier, even if that earlier race has already happened.
    await ctx.db.update(s.signUps).set({ verifications: {
      phone_number: { status: "verified", strategy: "phone_code", identifier: matches ? phone : "+15555550202" },
    } }).where(eq(s.signUps.id, started.response.id));
    const updated = await client.json<{ response: { status: string; unverified_fields: string[] } }>(
      `/v1/client/sign_ups/${started.response.id}`, { method: "PATCH", body: { first_name: "Ada" } },
    );
    expect(updated.response.status).toBe(matches ? "complete" : "missing_requirements");
    if (matches) {
      expect((await ctx.db.select().from(s.phoneNumbers))[0]?.verified).toBe(true);
    } else {
      expect(updated.response.unverified_fields).toContain("phone_number");
      expect(await ctx.db.select().from(s.users)).toHaveLength(0);
      // If the operator later makes verification optional, completing must still not label the number verified.
      await ctx.settings.update({ attributes: { phoneNumber: { verifyAtSignUp: false } } });
      const completed = await client.json<{ response: { status: string } }>(
        `/v1/client/sign_ups/${started.response.id}`, { method: "PATCH", body: { first_name: "Ada" } },
      );
      expect(completed.response.status).toBe("complete");
      expect((await ctx.db.select().from(s.phoneNumbers))[0]?.verified).toBe(false);
    }
  });
});

const BASE = "https://auth.acme.example";
const APP = "https://app.acme.example";
async function operatorInstance() {
  const h = await setup({ baseUrl: BASE, encryptionKey: "handoff-review-encryption-key-0123456789" });
  await h.ctx.settings.update({ application: { allowedOrigins: [APP], developmentMode: false } });
  const exchange = await h.app.request("/v1/operator_sessions", {
    method: "POST", headers: { origin: BASE, "content-type": "application/json" },
    body: JSON.stringify({ secret_key: h.ctx.env.secretKey }),
  });
  expect(exchange.status).toBe(201);
  const cookie = exchange.headers.getSetCookie().find((value) => value.startsWith(`${COOKIES.operator}=`))!.split(";")[0]!;
  return { ...h, cookie };
}

describe("operator cookies do not authenticate application traffic", () => {
  it("allows an application's first sign-up even when the browser has a same-site operator cookie", async () => {
    const { app, cookie } = await operatorInstance();
    const result = await app.request("/v1/client/sign_ups", {
      method: "POST", headers: { cookie, origin: APP, "sec-fetch-site": "same-site", "content-type": "application/json" },
      body: JSON.stringify({ email_address: "new@example.com", password: "Sup3rSecret!" }),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).response.status).toBe("missing_requirements");
  });

  it("lets a same-site SAML callback reach its own authentication guard", async () => {
    const { app, cookie } = await operatorInstance();
    const request = (cookie?: string) => app.request("/v1/saml/unknown/acs", {
      method: "POST", headers: { ...(cookie ? { cookie } : {}), origin: "https://login.acme.example", "sec-fetch-site": "same-site", "content-type": "application/x-www-form-urlencoded" },
      body: "SAMLResponse=invalid",
    });
    const without = await request();
    const withOperator = await request(cookie);
    expect(without.status).not.toBe(403);
    expect(withOperator.status).toBe(without.status);
  });

  it.each([false, true])("still rejects application-origin backend writes with an operator cookie and client cookie=%s", async (clientCookie) => {
    const { app, cookie } = await operatorInstance();
    const result = await app.request("/v1/users", {
      method: "POST", headers: { cookie: cookie + (clientCookie ? `; ${COOKIES.client}=unknown` : ""), origin: APP, "sec-fetch-site": "same-site", "content-type": "application/json" },
      body: JSON.stringify({ email_address: ["forbidden@example.com"] }),
    });
    expect(result.status).toBe(403);
  });
});

describe("imports cannot restore excluded operator sessions", () => {
  it("rejects an export that explicitly includes a live operator session before deleting target data", async () => {
    const source = await operatorInstance();
    const target = await operatorInstance();
    const retained = await createUser(target.ctx, { email: "retained@example.com", emailVerified: true });
    const dir = mkdtempSync(join(tmpdir(), "orbitid-excluded-session-"));
    try {
      const file = join(dir, "export.jsonl");
      await exportDatabase(source.ctx, { out: file });
      const lines = readFileSync(file, "utf8").trim().split("\n");
      const header = JSON.parse(lines[0]!);
      const rows = await source.ctx.db.select().from(s.operatorSessions);
      header.tables.push("operator_sessions");
      header.counts.operator_sessions = rows.length;
      const columns = getTableColumns(s.operatorSessions);
      const injected = rows.map((row) => JSON.stringify({ t: "operator_sessions", r: Object.fromEntries(
        Object.entries(columns).map(([prop, column]) => [column.name, row[prop as keyof typeof row]]),
      ) }));
      writeFileSync(file, [JSON.stringify(header), ...lines.slice(1), ...injected].join("\n") + "\n");
      await expect(importDatabase(target.ctx, { in: file, truncate: true, yes: true })).rejects.toThrow(/excluded.*operator_sessions/);
      expect((await target.ctx.db.select().from(s.users))[0]?.id).toBe(retained.id);
      expect((await target.app.request("/v1/instance", { headers: { cookie: target.cookie } })).status).toBe(200);
      expect((await target.app.request("/v1/instance", { headers: { cookie: source.cookie } })).status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
