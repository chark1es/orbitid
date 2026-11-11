// Remembered browsers that may skip the second factor until their token expires.
// Only the sha256 of the opaque token is stored; the plaintext lives in an HttpOnly cookie.
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { COOKIES } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { newId } from "../lib/ids";
import { requestIsSecure } from "../lib/http";
import { first } from "../lib/db";

export type TrustedDeviceRow = typeof s.trustedDevices.$inferSelect;

/** A short, human label such as "Safari on macOS", taken from the user agent. Falls back to a generic name. */
export function trustedDeviceLabel(userAgent?: string | null): string {
  if (!userAgent) return "Trusted browser";
  const ua = userAgent;
  const os = /iphone|ipod/i.test(ua) ? "iOS"
    : /ipad/i.test(ua) ? "iPadOS"
    : /android/i.test(ua) ? "Android"
    : /windows/i.test(ua) ? "Windows"
    : /mac os x|macintosh/i.test(ua) ? "macOS"
    : /cros/i.test(ua) ? "ChromeOS"
    : /linux|x11/i.test(ua) ? "Linux"
    : null;
  const browser = /edg(e|a|ios)?\//i.test(ua) ? "Edge"
    : /opr\/|opera/i.test(ua) ? "Opera"
    : /firefox|fxios/i.test(ua) ? "Firefox"
    : /chrome|crios|chromium/i.test(ua) ? "Chrome"
    : /safari/i.test(ua) ? "Safari"
    : null;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Browser on ${os}`;
  return "Trusted browser";
}

/** Not revoked and not past its expiry. */
export const trustedDeviceValid = (row: TrustedDeviceRow, at = Date.now()): boolean =>
  !row.revokedAt && row.expiresAt > at;

/** Device tokens are opaque and only their hash is stored; the plaintext never touches the database. */
const newDeviceToken = () => randomToken(32);

/** Sets the trusted-device cookie (API host, HttpOnly, SameSite=Lax, Secure over https). */
export function setTrustedDeviceCookie(c: Context, ctx: AppContext, token: string, expiresAt: number) {
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  setCookie(c, COOKIES.trustedDevice, token, {
    httpOnly: true,
    secure: requestIsSecure(c, ctx.env.baseUrl),
    sameSite: "Lax",
    path: "/",
    maxAge,
  });
}

export function clearTrustedDeviceCookie(c: Context) {
  deleteCookie(c, COOKIES.trustedDevice, { path: "/" });
}

/** The device token presented by this request, if any. */
export function readTrustedDeviceToken(c: Context): string | undefined {
  return getCookie(c, COOKIES.trustedDevice) || undefined;
}

/** Sets or clears the trusted-device cookie from a first-factor result. */
export function applyTrustedDeviceCookie(
  c: Context,
  ctx: AppContext,
  result: { trustedDeviceToken?: string; trustedDeviceExpiresAt?: number; clearTrustedDevice?: boolean },
) {
  if (result.trustedDeviceToken && result.trustedDeviceExpiresAt) {
    setTrustedDeviceCookie(c, ctx, result.trustedDeviceToken, result.trustedDeviceExpiresAt);
  } else if (result.clearTrustedDevice) {
    clearTrustedDeviceCookie(c);
  }
}

export interface IssueTrustedDeviceInput {
  userId: string;
  userAgent?: string | null;
  ip?: string | null;
}

/** Creates a remembered browser for `userId` (`now + settings.session.trustedDeviceDays`). */
export async function issueTrustedDevice(
  ctx: AppContext,
  input: IssueTrustedDeviceInput,
): Promise<{ row: TrustedDeviceRow; token: string }> {
  const now = Date.now();
  const token = newDeviceToken();
  const id = newId("tdev");
  const expiresAt = now + ctx.settings.get().session.trustedDeviceDays * 24 * 3600 * 1000;
  await ctx.db.insert(s.trustedDevices).values({
    id,
    userId: input.userId,
    tokenHash: sha256(token),
    label: trustedDeviceLabel(input.userAgent),
    userAgent: input.userAgent ?? null,
    ipAddress: input.ip ?? null,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const row = first(await ctx.db.select().from(s.trustedDevices).where(eq(s.trustedDevices.id, id)))!;
  return { row, token };
}

/**
 * Validates a device token for `userId` and rotates its value (the expiry never slides).
 * The rotate is a single compare-and-set, so a replayed (stolen) token cannot be redeemed twice.
 */
export async function redeemTrustedDevice(
  ctx: AppContext,
  token: string,
  userId: string,
): Promise<{ row: TrustedDeviceRow; token: string } | null> {
  if (!token) return null;
  const now = Date.now();
  const rotated = newDeviceToken();
  const row = first(await ctx.db.update(s.trustedDevices)
    .set({ tokenHash: sha256(rotated), lastUsedAt: now, updatedAt: now })
    .where(and(
      eq(s.trustedDevices.tokenHash, sha256(token)),
      eq(s.trustedDevices.userId, userId),
      isNull(s.trustedDevices.revokedAt),
      gt(s.trustedDevices.expiresAt, now),
    ))
    .returning());
  return row ? { row, token: rotated } : null;
}

export async function listTrustedDevices(ctx: AppContext, userId: string): Promise<TrustedDeviceRow[]> {
  const now = Date.now();
  return ctx.db.select().from(s.trustedDevices)
    .where(and(eq(s.trustedDevices.userId, userId), isNull(s.trustedDevices.revokedAt), gt(s.trustedDevices.expiresAt, now)))
    .orderBy(desc(s.trustedDevices.createdAt));
}

/** Revokes one device, scoped to its owner so another user's device is never touched. */
export async function revokeTrustedDevice(ctx: AppContext, userId: string, id: string): Promise<TrustedDeviceRow | null> {
  const now = Date.now();
  const row = first(await ctx.db.update(s.trustedDevices)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(s.trustedDevices.id, id), eq(s.trustedDevices.userId, userId), isNull(s.trustedDevices.revokedAt)))
    .returning());
  return row ?? null;
}

/** Revokes every remembered browser of a user (password change, second-factor reset, ban/lock). */
export async function revokeAllTrustedDevices(ctx: AppContext, userId: string): Promise<number> {
  const now = Date.now();
  const rows = await ctx.db.update(s.trustedDevices)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(s.trustedDevices.userId, userId), isNull(s.trustedDevices.revokedAt)))
    .returning({ id: s.trustedDevices.id });
  return rows.length;
}
