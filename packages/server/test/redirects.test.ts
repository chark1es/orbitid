import { describe, expect, it } from "vitest";
import { OrbitError } from "@orbitid/shared";
import { createContext } from "../src/bootstrap";
import { validateRedirectUrl } from "../src/modules/auth/redirects";

async function ctx() {
  const c = await createContext({ databasePath: ":memory:", secretKey: "sk_test_x", baseUrl: "http://localhost:4000" });
  await c.settings.update({ application: { homeUrl: "https://app.example.com", allowedOrigins: ["https://app.example.com"], developmentMode: false } });
  return c;
}

describe("validateRedirectUrl", () => {
  it("accepts paths and allowed origins", async () => {
    const c = await ctx();
    expect(validateRedirectUrl(c, "/dashboard?x=1")).toBe("https://app.example.com/dashboard?x=1");
    expect(validateRedirectUrl(c, "https://app.example.com/after")).toBe("https://app.example.com/after");
  });

  it.each(["https://evil.example/x", "//evil.example/x", "/\\evil.example/x", "\\\\evil.example/x", "/\\/evil.example", "javascript:alert(1)"])(
    "rejects %s",
    async (value) => {
      const c = await ctx();
      expect(() => validateRedirectUrl(c, value)).toThrow(OrbitError);
    },
  );
});
