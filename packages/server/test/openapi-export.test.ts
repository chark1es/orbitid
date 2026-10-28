import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { outputPath, render } from "../scripts/export-openapi";

/**
 * The committed `docs/openapi.json` must equal what the export script produces from the code.
 *
 * When this fails, run `bun run openapi:export` from `packages/server` and commit the result. That is the whole point:
 * the published document cannot drift from the server.
 */
describe("committed OpenAPI document", () => {
  it("matches the document generated from the code", () => {
    const committed = readFileSync(outputPath, "utf8");
    const generated = render();
    if (committed !== generated) {
      throw new Error(
        "docs/openapi.json is out of date. Run `bun run openapi:export` in packages/server and commit the result.",
      );
    }
    expect(committed.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(committed);
    expect(parsed.openapi).toBe("3.1.0");
    expect(Object.keys(parsed.paths).length).toBeGreaterThan(100);
  });

  it("uses the {baseUrl} placeholder and contains no real credentials", () => {
    const committed = readFileSync(outputPath, "utf8");
    const parsed = JSON.parse(committed);
    expect(parsed.servers).toEqual([{ url: "{baseUrl}", description: "This instance." }]);
    // Keys only appear as documentation placeholders; no concrete key of any kind may be committed.
    expect(committed).not.toMatch(/\bsk_(live|test)_[A-Za-z0-9]{8,}/);
    expect(committed).not.toMatch(/\bak_(live|test)_[A-Za-z0-9]{8,}/);
    expect(committed).not.toMatch(/\bwhsec_[A-Za-z0-9+/=]{8,}/);
  });
});
