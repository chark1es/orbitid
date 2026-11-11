import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decodePublishableKey } from "@orbitid/shared";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function bindFlags(script: string) {
  return {
    host: script.match(/-H\s+(\S+)/)?.[1] ?? null,
    port: Number(script.match(/-p\s+(\d+)/)?.[1] ?? NaN),
  };
}

describe("playground dev server origin", () => {
  const pkg = JSON.parse(read("../../package.json")) as { scripts: Record<string, string> };

  it.each(["dev", "start"])(
    'binds %s to localhost so the browser origin matches the instance cookie',
    (name) => {
      const script = pkg.scripts[name] ?? "";
      expect(bindFlags(script)).toEqual({ host: "localhost", port: 3300 });
      // Binding the loopback IP makes the page origin http://127.0.0.1:3300 while the instance's
      // session cookie is scoped to localhost, so password sign-in silently fails there.
      expect(script).not.toContain("127.0.0.1");
    },
  );

  it("keeps the README pointing at http://localhost:3300", () => {
    const readme = read("../../README.md");
    expect(readme).toContain("Open http://localhost:3300");
    expect(readme).not.toContain("bind to `127.0.0.1`");
  });

  it("keeps the example publishable key's API host on localhost", () => {
    const env = read("../../.env.example");
    const key = env.match(/^NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=(\S+)$/m)?.[1] ?? "";
    expect(key).not.toBe("");
    expect(decodePublishableKey(key).frontendApi).toBe("http://localhost:4000");
  });
});
