// Organization logo storage (upload dir under ctx.env.dataDir).
import type { Context } from "hono";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import { MAX_UPLOAD_BYTES, parseBody } from "../../lib/http";
import { assertImageBytes, IMAGE_CONTENT_TYPES, randomImageName, type ImageKind } from "../../lib/images";

export const UPLOAD_DIR = "uploads/orgs";
const MAX_LOGO_BYTES = MAX_UPLOAD_BYTES;
export function uploadDir(ctx: AppContext): string {
  const dir = resolve(ctx.env.dataDir, UPLOAD_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Persists an organization logo and returns its public file name. The declared MIME type is ignored:
 * only the bytes matter, and the stored extension follows what was actually detected.
 */
export function storeLogo(ctx: AppContext, orgId: string, data: Uint8Array, _declaredMime?: string): string {
  if (data.byteLength > MAX_LOGO_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Logo must be smaller than 5MB", { param_name: "file" });
  const kind: ImageKind = assertImageBytes(data, "file");
  const file = randomImageName(orgId, kind);
  writeFileSync(resolve(uploadDir(ctx), file), data);
  return file;
}

export function deleteLogoFile(ctx: AppContext, imageUrl: string | null): void {
  if (!imageUrl) return;
  const file = imageUrl.split("/organization_logos/")[1];
  if (!file || !/^[A-Za-z0-9_.-]+$/.test(file) || file.includes("..")) return;
  try { unlinkSync(resolve(uploadDir(ctx), file)); } catch { /* already gone */ }
}

export function logoContentType(file: string): string {
  const ext = file.split(".").pop() ?? "";
  return IMAGE_CONTENT_TYPES[ext as ImageKind] ?? "application/octet-stream";
}

export function readDataUrl(value: string): { data: Buffer; mime: string } {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(value.trim());
  if (!m) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "file must be a base64 data URL", { param_name: "file" });
  const data = Buffer.from(m[2]!, "base64");
  if (data.byteLength > MAX_LOGO_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Logo must be smaller than 5MB", { param_name: "file" });
  return { data, mime: m[1]!.toLowerCase() };
}

/** Multipart upload or `{ file: "data:image/png;base64,…" }` JSON. */
export async function readLogoPayload(c: Context): Promise<{ data: Buffer; mime: string }> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_LOGO_BYTES + 64 * 1024) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Logo must be smaller than 5MB", { param_name: "file" });
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || typeof file === "string") throw new OrbitError(422, ErrorCodes.form_param_missing, "file is missing", { param_name: "file" });
    if (file.size > MAX_LOGO_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Logo must be smaller than 5MB", { param_name: "file" });
    return { data: Buffer.from(await file.arrayBuffer()), mime: file.type || "application/octet-stream" };
  }
  const body = await parseBody(c, z.object({ file: z.string().min(1).max(MAX_LOGO_BYTES) }));
  return readDataUrl(body.file);
}
