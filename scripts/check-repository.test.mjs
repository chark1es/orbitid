import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brokenMarkdownLinks, isMaintainedText, localMarkdownLinks, MAX_BYTES, sizeViolation } from "./check-repository.mjs";

test("file limits include boundary values, CRLF and a final line without a newline", () => {
  assert.equal(sizeViolation("src/a.ts", Buffer.from("x\r\n".repeat(500))), null);
  assert.match(sizeViolation("src/a.ts", Buffer.from("x\n".repeat(500) + "x")), /501 lines/);
  assert.equal(sizeViolation("src/a.ts", Buffer.alloc(MAX_BYTES, 120)), null);
  assert.match(sizeViolation("src/a.ts", Buffer.alloc(MAX_BYTES + 1, 120)), /32769 bytes/);
});

test("generated outputs are exempt; maintained schemas, types, tests and documentation are not", () => {
  for (const file of ["docs/openapi.json", "packages/server/drizzle/postgres/meta/0001_snapshot.json", "apps/example-next/.next/types/a.ts", "apps/dashboard/dist/a.js"]) assert.equal(isMaintainedText(file), false);
  for (const file of ["packages/server/src/openapi/components.ts", "src/types.ts", "test/a.test.ts", "docs/API.md", "scripts/check-repository.mjs"]) assert.equal(isMaintainedText(file), true);
});

test("Markdown checks ignore external links, routes and fenced examples", () => {
  assert.deepEqual(localMarkdownLinks('[guide](guide.md#setup) [web](https://example.com) [heading](#setup) [route](/docs)\n```md\n[example](missing.md)\n```\n![image](<my image.png>)'), ["guide.md#setup", "my image.png"]);
});

test("Markdown checks detect removed targets and resolve relative and encoded filenames", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-doc-links-"));
  try {
    writeFileSync(join(dir, "my guide.md"), "# Guide\n");
    const findings = brokenMarkdownLinks(join(dir, "README.md"), "[valid](my%20guide.md#guide) [removed](old.md)");
    assert.equal(findings.length, 1);
    assert.match(findings[0], /missing link target old.md/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
