// Fixes from the second council round: session rotation on link completion, guest social connects, import completeness.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { handleExternalIdentity } from "../../src/services/external-identity";
import { exportDatabase, importDatabase } from "../../src/services/transfer";
import { latestLinkFor } from "../../src/services/mail";
import { setup, signUpUser, testClient } from "../core/helpers";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orbitid-r2-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a magic link replaces the client cookie", () => {
  it("does not leave the pre-login cookie valid for the new session", async () => {
    const { app } = await setup();
    await signUpUser(app, { email: "fixation@example.com", password: "Sup3rSecret!" });

    const browser = testClient(app);
    const created = await browser.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: "fixation@example.com", strategy: "email_link" } });
    await browser.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const before = browser.cookie!;
    const link = new URL(latestLinkFor("fixation@example.com")!);

    const click = await browser.request(`${link.pathname}${link.search}`);
    expect(click.headers.get("location")).toContain("__orbit_status=verified");
    expect(browser.cookie).not.toBe(before);
    // The cookie an attacker may have planted or copied earlier no longer reaches the session.
    const stale = testClient(app, before);
    expect((await stale.request("/v1/client/me")).status).toBe(401);
    expect((await browser.request("/v1/client/me")).status).toBe(200);
  });
});

describe("connecting a social account to a guest follows the sign-up restrictions", () => {
  it("refuses an address the allowlist does not admit and leaves the guest a guest", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ anonymous: { enabled: true } });
    const guest = testClient(app);
    const created = await guest.json<{ response: { created_user_id: string; created_session_id: string } }>("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    const clients = await ctx.db.select().from(schema.clients);
    // The instance closes sign-ups after the guest exists: connecting an identity is still a sign-up.
    await ctx.settings.update({ signUp: { mode: "restricted" } });

    const result = await handleExternalIdentity(
      ctx,
      { clientId: clients[0]!.id, kind: "connect", userId: created.response.created_user_id, redirectUrl: "http://localhost:3000/done" },
      { provider: "google", providerUserId: "g-1", email: "stranger@gmail.com", emailVerified: true },
    );
    expect(result.redirectTo).toContain("__orbit_error=sign_up_restricted");
    expect(result.redirectTo).not.toContain("connected");
    const user = (await ctx.db.select().from(schema.users).where(eq(schema.users.id, created.response.created_user_id)))[0]!;
    expect(user.isAnonymous).toBe(true);
    expect((await ctx.db.select({ n: count() }).from(schema.externalAccounts))[0]?.n).toBe(0);
  });
});

describe("a guest cannot attach a disposable address", () => {
  it("refuses it by name, not for some unrelated reason", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ anonymous: { enabled: true }, restrictions: { blockDisposableEmailDomains: true } });
    const guest = testClient(app);
    await guest.json("/v1/client/sign_ups", { body: { strategy: "anonymous" } });
    const res = await guest.json<{ errors: { code: string }[] }>("/v1/client/me/email_addresses", { body: { email_address: "x@mailinator.com" } });
    expect(res.errors?.[0]?.code).toBe("not_allowed_access");
  });
});

describe("a replacement import must account for every table it clears", () => {
  it("refuses a manifest that omits tables, before deleting anything", async () => {
    const { ctx, app } = await setup({ encryptionKey: "round-two-import-key-0123456789-abcdef" });
    await signUpUser(app);
    const file = join(tmp(), "export.jsonl");
    await exportDatabase(ctx, { out: file });

    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { tables: string[]; counts: Record<string, number> };
    const trimmed = { ...header, tables: ["instance"], counts: { instance: header.counts.instance ?? 0 } };
    const instanceRows = lines.slice(1).filter((line) => (JSON.parse(line) as { t: string }).t === "instance");
    writeFileSync(file, [JSON.stringify(trimmed), ...instanceRows].join("\n") + "\n");

    await expect(importDatabase(ctx, { in: file, truncate: true, yes: true })).rejects.toThrow(/incomplete/);
    expect(Number((await ctx.db.select({ n: count() }).from(schema.users))[0]?.n)).toBe(1);
  });

  it("refuses a header that lacks a row count", async () => {
    const { ctx, app } = await setup({ encryptionKey: "round-two-import-key-0123456789-abcdef" });
    await signUpUser(app);
    const file = join(tmp(), "export.jsonl");
    await exportDatabase(ctx, { out: file });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { counts: Record<string, number> };
    delete header.counts.users;
    writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n");
    await expect(importDatabase(ctx, { in: file, truncate: true, yes: true })).rejects.toThrow(/no row count/);
    expect(Number((await ctx.db.select({ n: count() }).from(schema.users))[0]?.n)).toBe(1);
    appendFileSync(file, "");
  });
});
