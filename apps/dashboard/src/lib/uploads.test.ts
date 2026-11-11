import { describe, expect, it, vi } from "vitest";
import { uploadFile } from "./uploads";

function file() {
  return new File(["logo"], "logo.png", { type: "image/png" });
}

describe("uploadFile", () => {
  it("returns the parsed JSON body on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "u_1" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    await expect(uploadFile<{ id: string }>("/users/u_1/profile_image", "POST", file())).resolves.toEqual({ id: "u_1" });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(url)).toContain("/v1/users/u_1/profile_image");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("turns a non-JSON 401 into the shared unauthorized event", async () => {
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>session expired</html>", { status: 401, statusText: "Unauthorized" }),
    );

    await expect(uploadFile("/organizations/org_1/logo", "PUT", file())).rejects.toMatchObject({
      status: 401,
      code: "unknown",
      message: "Unauthorized",
    });
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]![0] as CustomEvent<string>).detail).toMatch(/session ended/i);
    window.removeEventListener("orbitid:unauthorized", listener);
  });

  it("does not report a non-401 upload failure as an expired session", async () => {
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: "file_type_invalid", long_message: "PNG only" }] }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(uploadFile("/users/u_1/profile_image", "POST", file())).rejects.toMatchObject({
      status: 422,
      code: "file_type_invalid",
      message: "PNG only",
    });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("orbitid:unauthorized", listener);
  });
});
