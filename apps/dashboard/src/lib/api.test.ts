import { describe, expect, it, vi } from "vitest";
import { api, getSecretKey, setSecretKey } from "./api";

describe("api 401 handling", () => {
  it("clears the stored key and signals the guard globally", async () => {
    setSecretKey("sk_test_revoked");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: "authentication_invalid", message: "Invalid key" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);

    await expect(api("GET", "/instance")).rejects.toMatchObject({ status: 401, code: "authentication_invalid" });

    expect(getSecretKey()).toBe("");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("orbitid:unauthorized", listener);
  });

  it("keeps the key for non-auth errors", async () => {
    setSecretKey("sk_test_valid");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: "resource_not_found", message: "Missing" }] }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(api("GET", "/users/user_missing")).rejects.toMatchObject({ status: 404 });
    expect(getSecretKey()).toBe("sk_test_valid");
  });
});
