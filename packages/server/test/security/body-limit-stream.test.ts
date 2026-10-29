import { describe, expect, it } from "vitest";
import { setup } from "../core/helpers";

/** A body that has no Content-Length: chunks arrive until the server stops reading. */
function streamOf(bytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      const size = Math.min(chunk, bytes - sent);
      controller.enqueue(new Uint8Array(size).fill(97));
      sent += size;
    },
  });
}

async function post(path: string, bytes: number, contentType: string, extra: Record<string, string> = {}) {
  const { app } = await setup();
  return app.request(path, {
    method: "POST",
    headers: { "content-type": contentType, ...extra },
    body: streamOf(bytes),
    // @ts-expect-error Node's fetch needs this for a streamed request body.
    duplex: "half",
  });
}

describe("request body cap on streamed bodies", () => {
  it("refuses a streamed JSON body over 1 MB on an ordinary route", async () => {
    const res = await post("/v1/client/sign_ins", 3 * 1024 * 1024, "application/json");
    expect(res.status).toBe(413);
  });

  it("refuses a streamed body to an OAuth callback without a Content-Length", async () => {
    const res = await post("/v1/client/oauth_callback/google", 6 * 1024 * 1024, "application/x-www-form-urlencoded");
    expect(res.status).toBe(413);
  });

  it("refuses a streamed multipart body over the upload cap", async () => {
    const res = await post("/v1/client/me/profile_image", 7 * 1024 * 1024, "multipart/form-data; boundary=x", { cookie: "__client=x" });
    expect(res.status).toBe(413);
  });

  it("still accepts a normal small body", async () => {
    const { app } = await setup();
    const res = await app.request("/v1/client/sign_ins", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: "a@b.co" }) });
    expect(res.status).not.toBe(413);
  });
});
