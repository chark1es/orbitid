import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { looksLikeMarkup, sniffImage } from "../../src/lib/images";
import { setup, signUpUser } from "../core/helpers";
import { GIF_1X1, GIF_POLYGLOT, JPEG_1X1, PNG_1X1, PNG_WITH_TRAILER, SVG_PAYLOAD, WEBP_1X1 } from "./image-fixtures";

const dataUrl = (bytes: Buffer, mime = "image/png") => `data:${mime};base64,${bytes.toString("base64")}`;

describe("image sniffing", () => {
  it("detects the four allowed raster formats from their bytes", () => {
    expect(sniffImage(PNG_1X1)).toBe("png");
    expect(sniffImage(JPEG_1X1)).toBe("jpg");
    expect(sniffImage(GIF_1X1)).toBe("gif");
    expect(sniffImage(WEBP_1X1)).toBe("webp");
  });

  it("refuses SVG, HTML and anything that is not a raster image", () => {
    expect(sniffImage(SVG_PAYLOAD)).toBeNull();
    expect(looksLikeMarkup(SVG_PAYLOAD)).toBe(true);
    expect(sniffImage(Buffer.from("<html></html>"))).toBeNull();
    expect(sniffImage(Buffer.from("not an image"))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it("refuses a polyglot whose real image is followed by markup", () => {
    expect(sniffImage(GIF_POLYGLOT)).toBeNull();
    expect(sniffImage(PNG_WITH_TRAILER)).toBeNull();
    // A WebP whose declared RIFF size does not cover the extra bytes is a polyglot too.
    const lying = Buffer.from(WEBP_1X1);
    lying.writeUInt32LE(4, 4);
    expect(sniffImage(lying)).toBeNull();
  });
});

describe("avatar upload", () => {
  const withDataDir = () => mkdtempSync(join(tmpdir(), "orbitid-uploads-"));
  const uploadsOf = (dir: string) => (existsSync(join(dir, "uploads")) ? readdirSync(join(dir, "uploads")) : []);

  it("stores a real PNG under a random server-chosen name", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me/profile_image", { body: { file: dataUrl(PNG_1X1) } });
    expect(res.status).toBe(200);
    const body = await res.json();
    const file = /\/v1\/client\/images\/([^"?]+)/.exec(body.response.image_url)?.[1];
    expect(file).toMatch(/^user_[A-Za-z0-9]+_[a-f0-9]{24}\.png$/);
    expect(existsSync(join(dataDir, "uploads", file!))).toBe(true);
    expect(uploadsOf(dataDir)).toHaveLength(1);
  });

  it("ignores the client's file name entirely", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(PNG_1X1)], "../../etc/passwd.png", { type: "image/png" }));
    const res = await user.client.request("/v1/client/me/profile_image", { body: form });
    expect(res.status).toBe(200);
    const stored = uploadsOf(dataDir);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain("passwd");
    expect(stored[0]).toMatch(/^user_/);
  });

  it("ignores a lying content type: an SVG declared as image/png is refused", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me/profile_image", { body: { file: dataUrl(SVG_PAYLOAD, "image/png") } });
    expect(res.status).toBe(422);
    expect((await res.json()).errors[0].message).toContain("SVG");
    expect(uploadsOf(dataDir)).toHaveLength(0);
  });

  it("refuses a multipart upload whose declared type is an image but whose bytes are not", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    const form = new FormData();
    form.set("file", new File([new Uint8Array(SVG_PAYLOAD)], "avatar.png", { type: "image/png" }));
    const res = await user.client.request("/v1/client/me/profile_image", { body: form });
    expect(res.status).toBe(422);
    expect(uploadsOf(dataDir)).toHaveLength(0);
  });

  it("refuses a polyglot: a real GIF header with an HTML/script payload", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    const res = await user.client.request("/v1/client/me/profile_image", { body: { file: dataUrl(GIF_POLYGLOT, "image/gif") } });
    expect(res.status).toBe(422);
    expect(uploadsOf(dataDir)).toHaveLength(0);
  });

  it("serves stored images with nosniff and a sandbox CSP", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    const created = await user.client.request("/v1/client/me/profile_image", { body: { file: dataUrl(GIF_1X1, "image/gif") } });
    const file = /\/v1\/client\/images\/([^"?]+)/.exec((await created.json()).response.image_url)?.[1]!;
    const served = await user.client.request(`/v1/client/images/${file}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/gif");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
  });

  it("refuses an empty upload and an oversized one", async () => {
    const dataDir = withDataDir();
    const { app } = await setup({ dataDir });
    const user = await signUpUser(app);
    expect((await user.client.request("/v1/client/me/profile_image", { body: { file: "" } })).status).toBe(422);
    const huge = Buffer.concat([PNG_1X1, Buffer.alloc(5 * 1024 * 1024 + 8)]);
    expect((await user.client.request("/v1/client/me/profile_image", { body: { file: dataUrl(huge) } })).status).toBe(413);
    expect(uploadsOf(dataDir)).toHaveLength(0);
  });

  it("keeps the traversal guard on the image route", async () => {
    const { app } = await setup();
    for (const path of ["/v1/client/images/..%2F..%2Fetc%2Fpasswd", "/v1/client/images/evil.svg", "/v1/client/images/a..b.png"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
    }
  });
});

describe("organization logo upload", () => {
  it("refuses SVG and stores a random raster name", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "orbitid-logos-"));
    const { app, ctx } = await setup({ dataDir });
    await ctx.settings.update({ organizations: { enabled: true } });
    const user = await signUpUser(app);
    const created = await user.client.json<{ response: { id: string } }>("/v1/client/organizations", { body: { name: "Logo Co" } });

    const svg = await user.client.request(`/v1/client/organizations/${created.response.id}/logo`, {
      method: "PUT",
      body: { file: dataUrl(SVG_PAYLOAD, "image/svg+xml") },
    });
    expect(svg.status).toBe(422);

    const png = await user.client.request(`/v1/client/organizations/${created.response.id}/logo`, {
      method: "PUT",
      body: { file: dataUrl(PNG_1X1) },
    });
    expect(png.status).toBe(200);
    const body = await png.json();
    const file = /\/organization_logos\/([^"?]+)/.exec(body.response.image_url)?.[1]!;
    expect(file).toMatch(/^org_[A-Za-z0-9]+_[a-f0-9]{24}\.png$/);

    const row = (await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, created.response.id)))[0]!;
    expect(row.hasImage).toBe(true);

    const served = await app.request(`/v1/client/organization_logos/${file}`);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect((await app.request("/v1/client/organization_logos/..%2Fsecret.png")).status).toBe(404);
  });
});

describe("admin profile image", () => {
  it("accepts only an image data URL, never a remote URL the server would have to fetch", async () => {
    const { api } = await import("../admin/helpers").then((m) => m.testApp());
    const user = await (await import("../admin/helpers")).createUser(api);
    expect((await api("POST", `/v1/users/${user.id}/profile_image`, { file: "https://evil.example/x.png" })).status).toBe(422);
    expect((await api("POST", `/v1/users/${user.id}/profile_image`, { file: dataUrl(SVG_PAYLOAD, "image/svg+xml") })).status).toBe(422);
    expect((await api("POST", `/v1/users/${user.id}/profile_image`, { file: dataUrl(JPEG_1X1, "image/jpeg") })).status).toBe(200);
  });
});
