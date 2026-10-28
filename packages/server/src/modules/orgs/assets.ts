// OWNER: worker "orgs" (W2). Organization logo storage (upload dir under ctx.env.dataDir).
import type { Context } from "hono";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import { parseBody } from "../../lib/http";

export const UPLOAD_DIR = "uploads/orgs";
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const LOGO_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg",
};
const EXT_CONTENT_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
};
export function uploadDir(ctx: AppContext): string {
  const dir = resolve(ctx.env.dataDir, UPLOAD_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Persists an organization logo and returns its public file name. */
export function storeLogo(ctx: AppContext, orgId: string, data: Uint8Array, mime: string): string {
  const ext = LOGO_TYPES[mime.toLowerCase()];
  if (!ext) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `Unsupported image type "${mime}". Use PNG, JPEG, GIF, WebP or SVG.`, { param_name: "file" });
  if (data.byteLength > MAX_LOGO_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Logo must be smaller than 5MB", { param_name: "file" });
  const file = `${orgId}_${Date.now().toString(36)}.${ext}`;
  writeFileSync(resolve(uploadDir(ctx), file), data);
  return file;
}

export function deleteLogoFile(ctx: AppContext, imageUrl: string | null): void {
  if (!imageUrl) return;
  const file = imageUrl.split("/organization_logos/")[1];
  if (!file || !/^[A-Za-z0-9_.-]+$/.test(file)) return;
  try { unlinkSync(resolve(uploadDir(ctx), file)); } catch { /* already gone */ }
}

export function logoContentType(file: string): string {
  return EXT_CONTENT_TYPES[file.split(".").pop() ?? ""] ?? "application/octet-stream";
}

export function readDataUrl(value: string): { data: Buffer; mime: string } {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(value.trim());
  if (!m) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "file must be a base64 data URL", { param_name: "file" });
  return { data: Buffer.from(m[2]!, "base64"), mime: m[1]!.toLowerCase() };
}

/** Multipart upload or `{ file: "data:image/png;base64,…" }` JSON. */
export async function readLogoPayload(c: Context): Promise<{ data: Buffer; mime: string }> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || typeof file === "string") throw new OrbitError(422, ErrorCodes.form_param_missing, "file is missing", { param_name: "file" });
    return { data: Buffer.from(await file.arrayBuffer()), mime: file.type || "application/octet-stream" };
  }
  const body = await parseBody(c, z.object({ file: z.string().min(1) }));
  return readDataUrl(body.file);
}
