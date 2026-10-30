import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { passwordDigestKind } from "../../src/lib/password-digest";
import { verifyPassword, hashPassword } from "../../src/services/passwords";
import { setup } from "../core/helpers";
import * as s from "../../src/db/schema";

const salt = Buffer.from("safe-import-salt");
const key = scryptSync("correct password", salt, 32, { N: 16384, r: 8, p: 1 });
const scryptDigest = `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
const argonBase = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000";

describe("imported password digest limits", () => {
  it("verifies ordinary scrypt and generated Argon2 digests", async () => {
    expect(passwordDigestKind(scryptDigest)).toBe("scrypt");
    expect(await verifyPassword(scryptDigest, "correct password")).toBe(true);
    expect(await verifyPassword(scryptDigest, "wrong")).toBe(false);
    expect(await verifyPassword(await hashPassword("ordinary password"), "ordinary password")).toBe(true);
  });

  it.each([
    scryptDigest.replace("16384", "1073741824"),
    scryptDigest.replace("$8$1$", "$8$999999$"),
    argonBase.replace("m=19456", "m=999999999"),
    argonBase.replace("t=2", "t=999999999"),
    "$2b$31$" + "a".repeat(53),
    "x".repeat(1025),
  ])("refuses unsafe work factors or oversized stored digests without starting verification", async (digest) => {
    expect(passwordDigestKind(digest)).toBeNull();
    expect(await verifyPassword(digest, "guess")).toBe(false);
  });

  it("rejects an unsafe digest before creating an imported user", async () => {
    const { ctx, app } = await setup();
    const result = await app.request("/v1/users", { method: "POST", headers: { authorization: `Bearer ${ctx.env.secretKey}`, "content-type": "application/json" }, body: JSON.stringify({ email_address: ["import@example.test"], password_digest: scryptDigest.replace("16384", "1073741824"), password_hasher: "scrypt" }) });
    expect(result.status).toBe(422);
    expect((await result.json()).errors[0].meta.param_name).toBe("password_digest");
    expect(await ctx.db.select().from(s.users)).toEqual([]);
  });
});
