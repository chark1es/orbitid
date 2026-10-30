import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { createContext } from "../../src/bootstrap";
import { createApp } from "../../src/app";

it("the real smoke script supplies auth and a production-usable no-delivery password flow", async () => {
  const script = readFileSync(new URL("../../../../scripts/smoke-container.sh", import.meta.url), "utf8");
  const assignment = script.match(/^SECRET=.+$/m)?.[0];
  expect(assignment).toBeTruthy();
  const generateKey = () => execFileSync("bash", ["-c", `${assignment}\nprintf '%s' "$SECRET"`], { encoding: "utf8", env: { ...process.env, STAMP: "1-1" } });
  const secretKey = generateKey();
  expect(secretKey).toMatch(/^[a-f0-9]{64}$/);
  expect(generateKey()).not.toBe(secretKey);
  const patchCommand = script.match(/-X PATCH "\$base\/v1\/instance"[^\n]*\\\n\s*-d '([^']+)'/);
  expect(patchCommand).toBeTruthy();
  expect(patchCommand![0]).toContain('authorization: Bearer $secret');
  const patch = JSON.parse(patchCommand![1]!);
  vi.stubEnv("VITEST", "");
  vi.stubEnv("NODE_ENV", "production");
  try {
    const ctx = await createContext({ databaseUrl: ":memory:", nodeEnv: "production", secretKey, encryptionKey: "k".repeat(40), baseUrl: "http://localhost:4000" });
    const app = createApp(ctx);
    const configured = await app.request("/v1/instance", { method: "PATCH", headers: { authorization: `Bearer ${ctx.env.secretKey}`, "content-type": "application/json" }, body: JSON.stringify(patch) });
    expect(configured.status).toBe(200);
    const signup = await app.request("/v1/client/sign_ups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email_address: "smoke@example.test", password: "Sup3rSecret!" }) });
    expect(signup.status).toBe(200);
    expect((await signup.json()).response.created_session_id).toMatch(/^sess_/);
    const signin = await app.request("/v1/client/sign_ins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: "smoke@example.test", password: "Sup3rSecret!" }) });
    expect(signin.status).toBe(200);
    expect((await signin.json()).response.created_session_id).toMatch(/^sess_/);
  } finally { vi.unstubAllEnvs(); }
});
