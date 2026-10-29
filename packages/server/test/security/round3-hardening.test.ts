// Third-round review: unverified provider emails for guests, ambiguous unproven claims, versioned import exemptions.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { handleExternalIdentity } from "../../src/services/external-identity";
import { exportDatabase, importDatabase } from "../../src/services/transfer";
import { errorsOf, setup, signUpUser, testClient } from "../core/helpers";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a restricted instance needs a verified provider email to admit a guest", () => {
  it("refuses an allowlisted address the provider did not verify", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ anonymous: { enabled: true } });
    const guest = testClient(app);
    const created = await guest.json<{ response: { created_user_id: string } }>("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    const clients = await ctx.db.select().from(schema.clients);
    await ctx.settings.update({ signUp: { mode: "restricted" } });
    await ctx.db.insert(schema.allowlistIdentifiers).values({ id: "alw_1", identifier: "member@example.com", identifierType: "email_address", createdAt: Date.now(), updatedAt: Date.now() } as never);
    await ctx.settings.update({ restrictions: { allowlistEnabled: true } });

    const unverified = await handleExternalIdentity(
      ctx,
      { clientId: clients[0]!.id, kind: "connect", userId: created.response.created_user_id, redirectUrl: "http://localhost:3000/done" },
      { provider: "microsoft", providerUserId: "m-1", email: "member@example.com", emailVerified: false },
    );
    expect(unverified.redirectTo).toContain("__orbit_error=not_allowed_access");
    const user = (await ctx.db.select().from(schema.users).where(eq(schema.users.id, created.response.created_user_id)))[0]!;
    expect(user.isAnonymous).toBe(true);
  });
});

describe("two accounts cannot both rest on an unproven address", () => {
  it("refuses the second sign-up when the address is not verified at sign-up", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { emailAddress: { verifyAtSignUp: false } } });
    const first = testClient(app);
    const a = await first.json<{ response: { status: string } }>("/v1/client/sign_ups", { body: { email_address: "dup@example.com", password: "Sup3rSecret!" } });
    expect(a.response.status).toBe("complete");
    const second = testClient(app);
    const b = await second.json("/v1/client/sign_ups", { body: { email_address: "dup@example.com", password: "Other-Passw0rd!" } });
    expect(errorsOf(b)[0]?.code).toBe("form_identifier_exists");
  });
});

describe("import exemptions follow the export's schema version", () => {
  async function exportWithoutDeviceTables(version?: string) {
    const { ctx, app } = await setup({ encryptionKey: "round-three-import-key-0123456789-abcdef" });
    await signUpUser(app);
    const dir = mkdtempSync(join(tmpdir(), "orbitid-r3-"));
    dirs.push(dir);
    const file = join(dir, "export.jsonl");
    await exportDatabase(ctx, { out: file });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { tables: string[]; counts: Record<string, number>; schema_version: string };
    const omit = new Set(["trusted_devices", "device_codes"]);
    header.tables = header.tables.filter((t) => !omit.has(t));
    for (const name of omit) delete header.counts[name];
    if (version) header.schema_version = version;
    const rows = lines.slice(1).filter((line) => !omit.has((JSON.parse(line) as { t: string }).t));
    writeFileSync(file, [JSON.stringify(header), ...rows].join("\n") + "\n");
    return { ctx, file };
  }

  it("refuses a current-version export that leaves the device tables out", async () => {
    const { ctx, file } = await exportWithoutDeviceTables();
    await expect(importDatabase(ctx, { in: file, truncate: true, yes: true })).rejects.toThrow(/incomplete/);
    expect(Number((await ctx.db.select({ n: count() }).from(schema.users))[0]?.n)).toBe(1);
  });

  it("accepts an export from before those tables existed", async () => {
    const { ctx, file } = await exportWithoutDeviceTables(`${ctx_dialect()}:2:0001_old`);
    const result = await importDatabase(ctx, { in: file, truncate: true, yes: true });
    expect(result.ok).toBe(true);
  });
});

function ctx_dialect(): string {
  return process.env.ORBITID_DB_DIALECT === "postgres" ? "postgres" : "sqlite";
}

describe("a provider-verified address replaces an unproven claim", () => {
  it("lets the real owner sign up through an identity provider that verified the mailbox", async () => {
    const { app, ctx } = await setup();
    // Passwords are optional here so an identity-provider sign-up can complete on its own.
    await ctx.settings.update({ attributes: { emailAddress: { verifyAtSignUp: false }, password: { required: false } } });
    const squatter = testClient(app);
    const claimed = await squatter.json<{ response: { status: string } }>("/v1/client/sign_ups", { body: { email_address: "ceo@corp.example", password: "AttackerPass1!" } });
    expect(claimed.response.status).toBe("complete");

    const clients = await ctx.db.select().from(schema.clients);
    const owner = testClient(app);
    const started = await owner.json<{ response: { id: string } }>("/v1/client/sign_ups", { body: {} });
    const result = await handleExternalIdentity(
      ctx,
      { clientId: (await ctx.db.select().from(schema.clients)).find((c) => !clients.some((o) => o.id === c.id))?.id ?? clients[clients.length - 1]!.id, kind: "sign_up", ownerId: started.response.id, redirectUrl: "http://localhost:3000/done" },
      { provider: "google", providerUserId: "g-owner", email: "ceo@corp.example", emailVerified: true },
    );
    expect(result.redirectTo).not.toContain("__orbit_error");
    const rows = await ctx.db.select().from(schema.emailAddresses).where(eq(schema.emailAddresses.email, "ceo@corp.example"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verified).toBe(true);
  });
});
