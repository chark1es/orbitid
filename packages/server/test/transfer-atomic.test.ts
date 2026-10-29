// A failed import must leave the target exactly as it was, whatever the failure and whichever database it is.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { exportDatabase, importDatabase } from "../src/services/transfer";
import { setup, signUpUser } from "./core/helpers";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "orbitid-atomic-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const users = async (ctx: Awaited<ReturnType<typeof setup>>["ctx"]) => Number((await ctx.db.select({ n: count() }).from(schema.users))[0]?.n ?? 0);

describe("import is all or nothing", () => {
  it("keeps every existing row when the file breaks after the header", async () => {
    const { ctx, app } = await setup({ encryptionKey: "atomic-import-key-0123456789-abcdef" });
    await signUpUser(app);
    expect(await users(ctx)).toBe(1);

    const file = join(tmp(), "export.jsonl");
    await exportDatabase(ctx, { out: file });
    appendFileSync(file, "this is not json\n");

    await expect(importDatabase(ctx, { in: file, truncate: true, yes: true })).rejects.toThrow(/JSON Lines/);
    expect(await users(ctx)).toBe(1);
  });

  it("keeps existing rows when the header promises more rows than the file holds", async () => {
    const { ctx, app } = await setup({ encryptionKey: "atomic-import-key-0123456789-abcdef" });
    await signUpUser(app);
    const file = join(tmp(), "export.jsonl");
    await exportDatabase(ctx, { out: file });
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]!) as { counts: Record<string, number> };
    header.counts.users = (header.counts.users ?? 0) + 5;
    writeFileSync(file, [JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n");

    await expect(importDatabase(ctx, { in: file, truncate: true, yes: true })).rejects.toThrow(/verification failed/);
    expect(await users(ctx)).toBe(1);
  });

  it("still replaces the data when everything is valid", async () => {
    const { ctx, app } = await setup({ encryptionKey: "atomic-import-key-0123456789-abcdef" });
    await signUpUser(app);
    const file = join(tmp(), "export.jsonl");
    await exportDatabase(ctx, { out: file });
    await signUpUser(app, { email: "second@example.com" });
    expect(await users(ctx)).toBe(2);

    const result = await importDatabase(ctx, { in: file, truncate: true, yes: true });
    expect(result.ok).toBe(true);
    expect(await users(ctx)).toBe(1);
  });
});
