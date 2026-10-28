// Image upload sniffing: the bytes decide, never the declared content type or file extension.
//
// Only raster formats the browser decodes as pixels are accepted. SVG is refused unconditionally: it is
// an XML document, so it can carry script and would be an XSS vector when served from this origin.
import { randomBytes } from "node:crypto";
import { ErrorCodes, OrbitError } from "@orbitid/shared";

export type ImageKind = "png" | "jpg" | "gif" | "webp";

export const IMAGE_CONTENT_TYPES: Record<ImageKind, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export const IMAGE_EXTENSIONS: Record<ImageKind, string> = { png: "png", jpg: "jpg", gif: "gif", webp: "webp" };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Markup signatures that must never appear in an uploaded raster image. A polyglot is a file whose header
 * makes it look like an image while its body is HTML/SVG/script; scanning for these markers refuses it
 * regardless of where the payload starts.
 */
const MARKUP_MARKERS = ["<script", "<svg", "<?xml", "<!doctype", "<html", "<iframe", "<body", "javascript:"];

/** True when the buffer contains a markup/script signature anywhere (a polyglot, not a real image). */
export function containsMarkup(bytes: Uint8Array): boolean {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1").toLowerCase();
  return MARKUP_MARKERS.some((marker) => text.includes(marker));
}

/**
 * Detects the real format from the first bytes, or returns null for anything else (including SVG).
 * A file whose header says "image" but whose body carries markup is refused as a polyglot.
 */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let kind: ImageKind | null = null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) kind = "png";
  // JPEG: SOI marker followed by a segment marker.
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) kind = "jpg";
  // GIF87a / GIF89a
  else if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) kind = "gif";
  // RIFF....WEBP, where the declared RIFF size covers exactly this file (an appended payload is a polyglot).
  else if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") {
    kind = buf.readUInt32LE(4) + 8 === buf.length ? "webp" : null;
  }
  if (!kind) return null;
  return containsMarkup(buf) ? null : kind;
}

/** True when the payload looks like SVG/XML/HTML rather than a raster image (used to explain the rejection). */
export function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 512)).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<html") || head.startsWith("<!doctype") || head.startsWith("<script");
}

/** Rejects anything that is not PNG, JPEG, GIF or WebP, whatever the client declared. */
export function assertImageBytes(bytes: Uint8Array, paramName = "file"): ImageKind {
  const kind = sniffImage(bytes);
  if (kind) return kind;
  const message = looksLikeMarkup(bytes)
    ? "SVG and other markup files are not accepted; upload a PNG, JPEG, GIF or WebP image"
    : "The file is not a valid PNG, JPEG, GIF or WebP image";
  throw new OrbitError(422, ErrorCodes.form_param_format_invalid, message, { param_name: paramName });
}

/** Random, server-chosen file name. Client names never reach the filesystem. */
export function randomImageName(prefix: string, kind: ImageKind): string {
  return `${prefix}_${randomBytes(12).toString("hex")}.${IMAGE_EXTENSIONS[kind]}`;
}

/** Response headers for a stored image: never sniffed, and sandboxed in case a decoder is fooled. */
export const IMAGE_RESPONSE_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
} as const;
