import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { brokenMarkdownLinks, environmentFindings, isMaintainedText, localMarkdownLinks, MAX_BYTES, paywallFindings, sizeViolation } from "./check-repository.mjs";

test("file limits include boundary values, CRLF and a final line without a newline", () => {
  assert.equal(sizeViolation("src/a.ts", Buffer.from("x\r\n".repeat(500))), null);
  assert.match(sizeViolation("src/a.ts", Buffer.from("x\n".repeat(500) + "x")), /501 lines/);
  assert.equal(sizeViolation("src/a.ts", Buffer.alloc(MAX_BYTES, 120)), null);
  assert.match(sizeViolation("src/a.ts", Buffer.alloc(MAX_BYTES + 1, 120)), /32769 bytes/);
});

test("generated outputs are exempt; maintained schemas, types, tests and documentation are not", () => {
  for (const file of ["docs/openapi.json", "crates/orbitid-core/tests/fixtures/drizzle/0000_jazzy_shen.sql", "crates/orbitid-core/migrations/0001_baseline.sql", "apps/example-next/.next/types/a.ts", "apps/dashboard/dist/a.js"]) assert.equal(isMaintainedText(file), false);
  for (const file of ["packages/shared/src/config.ts", "src/types.ts", "test/a.test.ts", "docs/API.md", "scripts/check-repository.mjs"]) assert.equal(isMaintainedText(file), true);
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

test("paywall guard flags gating vocabulary in shipped copy and ignores tests and fixtures", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-paywall-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "docs"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "src", "__tests__"), { recursive: true });
    writeFileSync(join(dir, "docs", "PRICING.md"), "Upgrade your plan to unlock SAML.\n");
    writeFileSync(join(dir, "src", "gate.ts"), "// This feature is enterprise only.\n");
    writeFileSync(join(dir, "src", "free.ts"), "export const free = true;\n");
    writeFileSync(join(dir, "src", "__tests__", "gate.test.ts"), "expect('premium').toBeTruthy();\n");
    writeFileSync(join(dir, "src", "gate.test.ts"), "const plan = 'pro plan';\n");
    const findings = paywallFindings(dir);
    assert.equal(findings.length, 2);
    assert.match(findings.join("\n"), /docs\/PRICING\.md:1/);
    assert.match(findings.join("\n"), /src\/gate\.ts:1/);
    assert.doesNotMatch(findings.join("\n"), /free\.ts|__tests__|gate\.test\.ts/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the repository ships no gating vocabulary", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  assert.deepEqual(paywallFindings(root), []);
});

test("every server environment variable is documented", () => {
  const dir = mkdtempSync(join(tmpdir(), "orbit-env-docs-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "crates", "orbitid-core", "src"), { recursive: true });
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "crates", "orbitid-core", "src", "config.rs"), 'let a = env_var("ORBITID_DOCUMENTED"); let b = std::env::var("ORBITID_MISSING").ok();\n');
    writeFileSync(join(dir, "docs", "ENVIRONMENT.md"), "| `ORBITID_DOCUMENTED` | yes |\n");
    const findings = environmentFindings(dir);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /ORBITID_MISSING/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
